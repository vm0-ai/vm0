import { randomUUID } from "node:crypto";

import {
  ZERO_BROWSER_IDLE_LEASE_MINUTES,
  ZERO_BROWSER_PROVIDER_TIMEOUT_MINUTES,
  type ZeroBrowserSession,
  type ZeroBrowserSuspensionReason,
} from "@vm0/api-contracts/contracts/zero-browser";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  browserProfiles,
  browserThreadProfiles,
  browserSessionInstances,
  browserSessions,
} from "@vm0/db/schema/browser-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import { and, asc, desc, eq, inArray, lte, notExists, sql } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import { publishBrowserSessionChangedSafely } from "../external/realtime";
import { nowDate } from "../external/time";
import { settle, settleIncludingAbort } from "../utils";
import {
  BrowserUseProviderError,
  createBrowserUseProfile,
  createBrowserUseSession,
  deleteBrowserUseProfile,
  getBrowserUseSession,
  stopBrowserUseSession,
  type BrowserUseSession,
} from "./browser-use.service";
import {
  activePaidConcurrencySlots,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

const RECONCILE_BATCH_SIZE = 20;
const PROVIDER_CLEANUP_TIMEOUT_MS = 30_000;
const PROVIDER_START_LIFECYCLE_TIMEOUT_MS = 90_000;
const STRANDED_START_GRACE_MS = 60_000;
const MAX_PROVIDER_VALIDATION_ISSUES_TO_LOG = 10;
const IDLE_LEASE_MS = ZERO_BROWSER_IDLE_LEASE_MINUTES * 60_000;
const OWNED_BROWSER_STATUSES = [
  "creating",
  "active",
  "resuming",
  "stopping",
] as const;
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;
const L = logger("ZeroBrowser");

type BrowserSessionRow = typeof browserSessions.$inferSelect;
type BrowserInstanceRow = typeof browserSessionInstances.$inferSelect;
type BrowserProfileRow = typeof browserProfiles.$inferSelect;
type BrowserThreadProfileRow = typeof browserThreadProfiles.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface BrowserProfilePair {
  readonly compatibilityProfile: BrowserProfileRow;
  readonly threadProfile: BrowserThreadProfileRow;
}

export interface BrowserServiceError {
  readonly kind: "error";
  readonly status: 400 | 403 | 404 | 409 | 502 | 503;
  readonly code: string;
  readonly message: string;
}

interface BrowserServiceOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

type BrowserServiceResult<T> = BrowserServiceOk<T> | BrowserServiceError;

interface BrowserConnection {
  readonly browser: ZeroBrowserSession;
  readonly cdpUrl: string;
}

interface BrowserActor {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
}

interface BrowserRunContext {
  readonly orgId: string;
  readonly userId: string;
  // Run associated with the provider instance. For run tokens this is the
  // calling run; for viewer requests it is the thread's most recent run.
  readonly runId: string;
  readonly chatThreadId: string;
  // Viewer requests may start a browser while no run is alive, so only run
  // tokens assert that their own run is still running.
  readonly requireLiveRun: boolean;
}

interface BrowserCreateInput {
  readonly name: string;
  readonly proxyCountryCode: string | null;
}

interface BrowserSessionAccess {
  readonly orgId: string;
  readonly userId: string;
  readonly browserId: string;
  readonly chatThreadId?: string;
}

interface ProviderResult<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface BrowserReleaseResult {
  readonly released: number;
}

interface BrowserReconcileResult {
  readonly checked: number;
  readonly stopped: number;
  readonly errors: number;
  readonly healthy: number;
}

function serviceError(
  status: BrowserServiceError["status"],
  code: string,
  message: string,
): BrowserServiceError {
  return { kind: "error", status, code, message };
}

function notFound(): BrowserServiceError {
  return serviceError(404, "BROWSER_NOT_FOUND", "Managed browser not found");
}

function conflict(message: string, code = "BROWSER_CONFLICT") {
  return serviceError(409, code, message);
}

function providerFailure(error: unknown): BrowserServiceError {
  if (error instanceof BrowserUseProviderError) {
    return serviceError(error.status, error.code, error.message);
  }
  if (error instanceof z.ZodError) {
    const validationIssueCount = error.issues.length;
    L.warn("Managed browser provider returned an invalid response", {
      validationIssueCount,
      validationIssues: error.issues
        .slice(0, MAX_PROVIDER_VALIDATION_ISSUES_TO_LOG)
        .map((issue) => {
          return {
            path:
              issue.path.length === 0
                ? "<root>"
                : issue.path.map(String).join("."),
            code: issue.code,
            message: issue.message,
          };
        }),
      validationIssuesOmitted: Math.max(
        0,
        validationIssueCount - MAX_PROVIDER_VALIDATION_ISSUES_TO_LOG,
      ),
    });
    return serviceError(
      502,
      "BROWSER_USE_INVALID_RESPONSE",
      "Managed browser provider returned an invalid response",
    );
  }
  throw error;
}

async function providerCall<T>(
  request: Promise<T>,
): Promise<ProviderResult<T> | BrowserServiceError> {
  const result = await settle(request);
  return result.ok
    ? { kind: "ok", value: result.value }
    : providerFailure(result.error);
}

function browserViewerUrl(browserId: string): string {
  return `${env("APP_URL").replace(/\/+$/u, "")}/browsers/${browserId}`;
}

function publicBrowser(
  row: BrowserSessionRow,
  liveUrl: string | null,
  idleExpiresAt: Date | null = null,
): ZeroBrowserSession {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    viewerUrl: browserViewerUrl(row.id),
    liveUrl,
    proxyCountryCode: row.proxyCountryCode,
    timeoutMinutes: row.timeoutMinutes,
    idleExpiresAt: idleExpiresAt?.toISOString() ?? null,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    suspensionReason: row.suspensionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nextIdleDeadline(): Date {
  return new Date(nowDate().getTime() + IDLE_LEASE_MS);
}

// Extending the lease is unconditional and fixed-length: every toucher gets the
// same 10 minutes from now, so leases cannot be stacked into a longer lifetime.
async function touchInstanceLease(
  db: Db,
  providerSessionId: string,
  signal: AbortSignal,
): Promise<BrowserInstanceRow | null> {
  const [touched] = await db
    .update(browserSessionInstances)
    .set({
      lastTouchedAt: nowDate(),
      idleExpiresAt: nextIdleDeadline(),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(browserSessionInstances.providerSessionId, providerSessionId),
        eq(browserSessionInstances.status, "active"),
      ),
    )
    .returning();
  signal.throwIfAborted();
  return touched ?? null;
}

interface ActiveBrowserInstance {
  readonly browserId: string;
  readonly chatThreadId: string;
  readonly providerSessionId: string;
  readonly userId: string;
}

function stopProviderSessionLater(providerSessionId: string): void {
  waitUntil(
    (async () => {
      const result = await settleIncludingAbort(
        stopBrowserUseSession(
          providerSessionId,
          AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
        ),
      );
      if (!result.ok) {
        L.warn("Managed browser provider stop failed", {
          providerSessionId,
          error: result.error,
        });
      }
    })(),
  );
}

async function stopActiveBrowserInstance(
  db: Db,
  target: ActiveBrowserInstance,
  reason: ZeroBrowserSuspensionReason,
  signal: AbortSignal,
  options: { readonly stopProvider: boolean } = { stopProvider: true },
): Promise<boolean> {
  const stopped = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, target.chatThreadId);
    const [instance] = await tx
      .update(browserSessionInstances)
      .set({
        status: "stopped",
        stopRequestedAt: nowDate(),
        finishedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(
            browserSessionInstances.providerSessionId,
            target.providerSessionId,
          ),
          eq(browserSessionInstances.status, "active"),
        ),
      )
      .returning({
        providerSessionId: browserSessionInstances.providerSessionId,
      });
    if (!instance) {
      return false;
    }
    await tx
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: nowDate(),
        suspensionReason: reason,
        updatedAt: nowDate(),
      })
      .where(eq(browserSessions.id, target.browserId));
    return true;
  });
  if (stopped && options.stopProvider) {
    stopProviderSessionLater(target.providerSessionId);
  }
  signal.throwIfAborted();
  if (!stopped) {
    return false;
  }
  await publishBrowserSessionChangedSafely(target.userId, target.browserId);
  signal.throwIfAborted();
  return true;
}

async function browserConcurrencyLimit(db: Db, orgId: string): Promise<number> {
  const [capabilities, paidSlots] = await Promise.all([
    loadOrgPlanCapabilities(db, orgId),
    activePaidConcurrencySlots(db, orgId),
  ]);
  if (!capabilities) {
    return 0;
  }
  return totalConcurrencyLimit({
    baseLimit: cappedBaseConcurrencyLimit(capabilities.baseConcurrencyLimit),
    paidSlots,
  });
}

async function ensureBrowserCapacity(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<BrowserServiceError | null> {
  const limit = await browserConcurrencyLimit(db, orgId);
  signal.throwIfAborted();
  if (limit === 0) {
    return conflict(
      "This organization has no managed browser concurrency available",
      "BROWSER_CONCURRENCY_LIMIT",
    );
  }
  if (!Number.isFinite(limit)) {
    return null;
  }
  const active = await db
    .select({
      browserId: browserSessions.id,
      chatThreadId: browserSessions.chatThreadId,
      providerSessionId: browserSessionInstances.providerSessionId,
      userId: browserSessions.userId,
    })
    .from(browserSessionInstances)
    .innerJoin(
      browserSessions,
      eq(browserSessions.id, browserSessionInstances.browserSessionId),
    )
    .where(
      and(
        eq(browserSessions.orgId, orgId),
        eq(browserSessionInstances.status, "active"),
      ),
    )
    .orderBy(
      asc(browserSessionInstances.idleExpiresAt),
      asc(browserSessionInstances.startedAt),
    );
  signal.throwIfAborted();
  const reclaimCount = active.length - limit + 1;
  for (const target of active.slice(0, Math.max(reclaimCount, 0))) {
    await stopActiveBrowserInstance(db, target, "reconcile", signal);
  }
  return null;
}

async function lockBrowserThread(
  tx: DbTransaction,
  chatThreadId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('zero_browser:' || ${chatThreadId}))`,
  );
}

async function lockBrowserProfileCreation(
  tx: DbTransaction,
  chatThreadId: string,
): Promise<void> {
  const lockKey = `zero_browser_profile:${chatThreadId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

async function latestThreadRunId(
  db: Pick<Db, "select">,
  chatThreadId: string,
): Promise<string | null> {
  const [run] = await db
    .select({ id: zeroRuns.id })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(eq(zeroRuns.chatThreadId, chatThreadId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run?.id ?? null;
}

async function resolveRunContext(
  db: Db,
  actor: BrowserActor,
): Promise<BrowserServiceResult<BrowserRunContext>> {
  if (!actor.runId) {
    return serviceError(
      400,
      "BROWSER_RUN_REQUIRED",
      "Managed browsers can only be started from a Zero chat run",
    );
  }
  const [run] = await db
    .select({
      chatThreadId: zeroRuns.chatThreadId,
      status: agentRuns.status,
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
    .where(
      and(
        eq(zeroRuns.id, actor.runId),
        eq(agentRuns.orgId, actor.orgId),
        eq(agentRuns.userId, actor.userId),
      ),
    )
    .limit(1);
  if (!run?.chatThreadId) {
    return serviceError(
      400,
      "BROWSER_CHAT_THREAD_REQUIRED",
      "Managed browsers can only be started from a Zero chat run",
    );
  }
  if (isTerminalRunStatus(run.status)) {
    return conflict("The chat run already ended", "BROWSER_RUN_ENDED");
  }
  if (!run.cloudBrowserEnabled) {
    return serviceError(
      403,
      "BROWSER_AUTHORIZATION_REQUIRED",
      "Cloud browser is not enabled for this chat thread",
    );
  }
  return {
    kind: "ok",
    value: {
      orgId: actor.orgId,
      userId: actor.userId,
      runId: actor.runId,
      chatThreadId: run.chatThreadId,
      requireLiveRun: true,
    },
  };
}

async function resolveViewerContext(
  db: Db,
  browser: BrowserSessionRow,
): Promise<BrowserServiceResult<BrowserRunContext>> {
  const [thread] = await db
    .select({ cloudBrowserEnabled: chatThreads.cloudBrowserEnabled })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, browser.chatThreadId),
        eq(chatThreads.userId, browser.userId),
      ),
    )
    .limit(1);
  if (!thread?.cloudBrowserEnabled) {
    return serviceError(
      403,
      "BROWSER_AUTHORIZATION_REQUIRED",
      "Cloud browser is not enabled for this chat thread",
    );
  }
  const latestRunId =
    (await latestThreadRunId(db, browser.chatThreadId)) ?? browser.runId;
  if (!latestRunId) {
    return conflict(
      "This browser's chat thread has no run; send a message first",
      "BROWSER_RUN_REQUIRED",
    );
  }
  return {
    kind: "ok",
    value: {
      orgId: browser.orgId,
      userId: browser.userId,
      runId: latestRunId,
      chatThreadId: browser.chatThreadId,
      requireLiveRun: false,
    },
  };
}

async function loadOwnedBrowser(
  db: Db,
  access: BrowserSessionAccess,
): Promise<BrowserSessionRow | null> {
  const [row] = await db
    .select({ browser: browserSessions })
    .from(browserSessions)
    .innerJoin(chatThreads, eq(chatThreads.id, browserSessions.chatThreadId))
    .where(
      and(
        eq(browserSessions.id, access.browserId),
        eq(browserSessions.orgId, access.orgId),
        eq(browserSessions.userId, access.userId),
        ...(access.chatThreadId
          ? [eq(browserSessions.chatThreadId, access.chatThreadId)]
          : []),
      ),
    )
    .limit(1);
  return row?.browser ?? null;
}

async function loadCurrentBrowser(
  db: Db,
  context: Pick<BrowserRunContext, "orgId" | "userId" | "chatThreadId">,
): Promise<BrowserSessionRow | null> {
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.chatThreadId, context.chatThreadId),
        eq(browserSessions.orgId, context.orgId),
        eq(browserSessions.userId, context.userId),
      ),
    )
    .orderBy(desc(browserSessions.createdAt))
    .limit(1);
  return row ?? null;
}

async function loadOwnedThreadBrowser(
  db: Db,
  chatThreadId: string,
): Promise<BrowserSessionRow | null> {
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.chatThreadId, chatThreadId),
        inArray(browserSessions.status, [...OWNED_BROWSER_STATUSES]),
      ),
    )
    .orderBy(desc(browserSessions.createdAt))
    .limit(1);
  return row ?? null;
}

async function loadActiveInstance(
  db: Db,
  browserSessionId: string,
): Promise<BrowserInstanceRow | null> {
  const [row] = await db
    .select()
    .from(browserSessionInstances)
    .where(
      and(
        eq(browserSessionInstances.browserSessionId, browserSessionId),
        eq(browserSessionInstances.status, "active"),
      ),
    )
    .orderBy(desc(browserSessionInstances.createdAt))
    .limit(1);
  return row ?? null;
}

async function loadOwnedThreadBrowserProfile(
  db: Db,
  owner: Pick<BrowserRunContext, "orgId" | "userId" | "chatThreadId">,
): Promise<BrowserThreadProfileRow | null> {
  const [row] = await db
    .select()
    .from(browserThreadProfiles)
    .where(
      and(
        eq(browserThreadProfiles.chatThreadId, owner.chatThreadId),
        eq(browserThreadProfiles.orgId, owner.orgId),
        eq(browserThreadProfiles.userId, owner.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadOwnedCompatibilityBrowserProfile(
  db: Db,
  owner: Pick<BrowserRunContext, "orgId" | "userId">,
): Promise<BrowserProfileRow | null> {
  const [row] = await db
    .select()
    .from(browserProfiles)
    .where(
      and(
        eq(browserProfiles.orgId, owner.orgId),
        eq(browserProfiles.userId, owner.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadBrowserProfileForBrowser(
  db: Db,
  browser: BrowserSessionRow,
): Promise<Pick<BrowserProfileRow, "id" | "providerProfileId">> {
  if (browser.browserThreadProfileId) {
    const [row] = await db
      .select()
      .from(browserThreadProfiles)
      .where(
        and(
          eq(browserThreadProfiles.id, browser.browserThreadProfileId),
          eq(browserThreadProfiles.chatThreadId, browser.chatThreadId),
          eq(browserThreadProfiles.orgId, browser.orgId),
          eq(browserThreadProfiles.userId, browser.userId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new Error("Managed browser thread profile ownership is invalid");
    }
    return row;
  }
  if (browser.browserProfileId) {
    const [row] = await db
      .select()
      .from(browserProfiles)
      .where(
        and(
          eq(browserProfiles.id, browser.browserProfileId),
          eq(browserProfiles.orgId, browser.orgId),
          eq(browserProfiles.userId, browser.userId),
        ),
      )
      .limit(1);
    if (row) {
      return row;
    }
  }
  throw new Error("Managed browser profile ownership is invalid");
}

async function deleteUnusedProfile(profileId: string): Promise<void> {
  await settle(
    deleteBrowserUseProfile(
      profileId,
      AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
    ),
  );
}

async function claimBrowserProfile(
  db: Db,
  args: {
    readonly id: string;
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly providerProfileId: string;
  },
): Promise<{
  readonly profile: BrowserThreadProfileRow;
  readonly created: boolean;
}> {
  const [created] = await db
    .insert(browserThreadProfiles)
    .values(args)
    .onConflictDoNothing({
      target: browserThreadProfiles.chatThreadId,
    })
    .returning();
  if (created) {
    return { profile: created, created: true };
  }
  const existing = await loadOwnedThreadBrowserProfile(db, args);
  if (!existing) {
    throw new Error("Managed browser profile claim did not resolve an owner");
  }
  return { profile: existing, created: false };
}

async function getOrCreateCompatibilityBrowserProfile(
  db: Db,
  args: Pick<BrowserRunContext, "orgId" | "userId"> & {
    readonly providerProfileId: string;
  },
): Promise<BrowserProfileRow> {
  const [created] = await db
    .insert(browserProfiles)
    .values({
      id: randomUUID(),
      orgId: args.orgId,
      userId: args.userId,
      providerProfileId: args.providerProfileId,
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    return created;
  }
  const existing = await loadOwnedCompatibilityBrowserProfile(db, args);
  if (!existing) {
    throw new Error(
      "Managed browser compatibility profile claim did not resolve an owner",
    );
  }
  return existing;
}

async function getOrCreateBrowserProfile(
  db: Db,
  context: BrowserRunContext,
): Promise<BrowserServiceResult<BrowserProfilePair>> {
  const existing = await loadOwnedThreadBrowserProfile(db, context);
  if (existing) {
    return {
      kind: "ok",
      value: {
        compatibilityProfile: await getOrCreateCompatibilityBrowserProfile(db, {
          ...context,
          providerProfileId: existing.providerProfileId,
        }),
        threadProfile: existing,
      },
    };
  }

  let createdProviderProfileId: string | null = null;
  let retainedCreatedProfile = false;
  const transaction = await settle(
    db.transaction(async (tx) => {
      await lockBrowserProfileCreation(tx, context.chatThreadId);
      const lockedExisting = await loadOwnedThreadBrowserProfile(tx, context);
      if (lockedExisting) {
        return {
          kind: "ok" as const,
          value: {
            compatibilityProfile: await getOrCreateCompatibilityBrowserProfile(
              tx,
              {
                ...context,
                providerProfileId: lockedExisting.providerProfileId,
              },
            ),
            threadProfile: lockedExisting,
          },
        };
      }

      const browserProfileId = randomUUID();
      const provider = await providerCall(
        createBrowserUseProfile(
          browserProfileId,
          AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
        ),
      );
      if (provider.kind === "error") {
        return provider;
      }
      createdProviderProfileId = provider.value;

      const claimed = await claimBrowserProfile(tx, {
        id: browserProfileId,
        orgId: context.orgId,
        userId: context.userId,
        chatThreadId: context.chatThreadId,
        providerProfileId: provider.value,
      });
      retainedCreatedProfile = claimed.created;
      return {
        kind: "ok" as const,
        value: {
          compatibilityProfile: await getOrCreateCompatibilityBrowserProfile(
            tx,
            {
              ...context,
              providerProfileId: claimed.profile.providerProfileId,
            },
          ),
          threadProfile: claimed.profile,
        },
      };
    }),
  );
  if (
    createdProviderProfileId &&
    (!transaction.ok || !retainedCreatedProfile)
  ) {
    await deleteUnusedProfile(createdProviderProfileId);
  }
  if (!transaction.ok) {
    throw transaction.error;
  }
  return transaction.value;
}

async function claimStartedProviderInstance(
  db: Db,
  args: {
    readonly browser: BrowserSessionRow;
    readonly context: BrowserRunContext;
    readonly provider: BrowserUseSession;
  },
) {
  const claimed = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, args.context.chatThreadId);
    const [current] = await tx
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, args.browser.id))
      .limit(1);
    if (!current || current.runId !== args.context.runId) {
      return { kind: "rejected" as const };
    }
    const cleanupAfterStart = current.status === "stopping";
    if (
      !cleanupAfterStart &&
      !["creating", "resuming"].includes(current.status)
    ) {
      return { kind: "rejected" as const };
    }
    const [instance] = await tx
      .insert(browserSessionInstances)
      .values({
        providerSessionId: args.provider.id,
        browserSessionId: current.id,
        chatThreadId: current.chatThreadId,
        runId: args.context.runId,
        status: cleanupAfterStart ? "stopped" : "active",
        timeoutAt: new Date(args.provider.timeoutAt),
        startedAt: new Date(args.provider.startedAt),
        lastTouchedAt: nowDate(),
        idleExpiresAt: nextIdleDeadline(),
        stopRequestedAt: cleanupAfterStart ? nowDate() : null,
        finishedAt: cleanupAfterStart ? nowDate() : null,
      })
      .returning();
    if (!instance) {
      throw new Error("Failed to persist managed browser provider instance");
    }
    if (cleanupAfterStart) {
      const [browser] = await tx
        .update(browserSessions)
        .set({
          status: "suspended",
          suspendedAt: nowDate(),
          suspensionReason: current.suspensionReason ?? "reconcile",
          updatedAt: nowDate(),
        })
        .where(eq(browserSessions.id, current.id))
        .returning();
      if (!browser) {
        throw new Error("Failed to suspend managed browser");
      }
      return {
        kind: "cleanup" as const,
        browser,
        instance,
      };
    }
    const [browser] = await tx
      .update(browserSessions)
      .set({
        status: "active",
        suspendedAt: null,
        suspensionReason: null,
        updatedAt: nowDate(),
      })
      .where(eq(browserSessions.id, current.id))
      .returning();
    if (!browser) {
      throw new Error("Failed to activate managed browser");
    }
    return { kind: "active" as const, browser, instance };
  });
  if (
    claimed.kind === "cleanup" ||
    (claimed.kind === "active" && args.browser.status === "resuming")
  ) {
    await publishBrowserSessionChangedSafely(
      args.browser.userId,
      args.browser.id,
    );
  }
  return claimed;
}

async function createAndClaimProviderInstance(
  db: Db,
  args: {
    readonly browser: BrowserSessionRow;
    readonly profile: Pick<BrowserProfileRow, "id" | "providerProfileId">;
    readonly context: BrowserRunContext;
  },
) {
  const provider = await providerCall(
    createBrowserUseSession(
      {
        profileId: args.profile.providerProfileId,
        proxyCountryCode: args.browser.proxyCountryCode,
        // Zero owns reclamation through the idle lease, so the provider only
        // needs to enforce the absolute upper bound.
        timeoutMinutes: ZERO_BROWSER_PROVIDER_TIMEOUT_MINUTES,
      },
      AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
    ),
  );
  if (provider.kind === "error") {
    return provider;
  }
  const { cdpUrl, liveUrl } = provider.value;
  if (provider.value.status !== "active" || !cdpUrl || !liveUrl) {
    stopProviderSessionLater(provider.value.id);
    return serviceError(
      502,
      "BROWSER_USE_INVALID_RESPONSE",
      "Managed browser provider did not return an active connection",
    );
  }

  const claimed = await claimStartedProviderInstance(db, {
    browser: args.browser,
    context: args.context,
    provider: provider.value,
  });
  return {
    kind: "claimed" as const,
    provider: provider.value,
    cdpUrl,
    liveUrl,
    claimed,
  };
}

const startProviderInstance$ = command(
  async (
    { set },
    args: {
      readonly browser: BrowserSessionRow;
      readonly context: BrowserRunContext;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const capacityError = await ensureBrowserCapacity(
      db,
      args.context.orgId,
      signal,
    );
    signal.throwIfAborted();
    if (capacityError) {
      return capacityError;
    }
    const profile = await loadBrowserProfileForBrowser(db, args.browser);
    signal.throwIfAborted();

    const started = await createAndClaimProviderInstance(db, {
      browser: args.browser,
      profile,
      context: args.context,
    });
    signal.throwIfAborted();
    if (started.kind === "error") {
      return started;
    }
    const { claimed } = started;

    if (claimed.kind === "cleanup") {
      stopProviderSessionLater(claimed.instance.providerSessionId);
      signal.throwIfAborted();
      return conflict(
        "The chat run ended while the managed browser was starting",
        "BROWSER_RUN_ENDED",
      );
    }

    if (claimed.kind === "rejected") {
      stopProviderSessionLater(started.provider.id);
      signal.throwIfAborted();
      return conflict(
        "The chat run ended while the managed browser was starting",
        "BROWSER_RUN_ENDED",
      );
    }

    return {
      kind: "ok",
      value: {
        browser: publicBrowser(
          claimed.browser,
          started.liveUrl,
          claimed.instance.idleExpiresAt,
        ),
        cdpUrl: started.cdpUrl,
      },
    };
  },
);

async function claimFreshBrowser(
  db: Db,
  context: BrowserRunContext,
  args: BrowserCreateInput & {
    readonly browserId: string;
    readonly browserProfileId: string;
    readonly browserThreadProfileId: string;
  },
  signal: AbortSignal,
): Promise<BrowserServiceResult<BrowserSessionRow>> {
  return await db.transaction(async (tx) => {
    await lockBrowserThread(tx, context.chatThreadId);
    signal.throwIfAborted();
    const [owned, run] = await Promise.all([
      tx
        .select({ id: browserSessions.id })
        .from(browserSessions)
        .where(
          and(
            eq(browserSessions.chatThreadId, context.chatThreadId),
            inArray(browserSessions.status, [...OWNED_BROWSER_STATUSES]),
          ),
        )
        .limit(1),
      tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, context.runId))
        .limit(1),
    ]);
    if (
      context.requireLiveRun &&
      (!run[0] || isTerminalRunStatus(run[0].status))
    ) {
      return conflict("The chat run already ended", "BROWSER_RUN_ENDED");
    }
    if (owned[0]) {
      return conflict(
        "This chat thread already has an active managed browser",
        "BROWSER_THREAD_ACTIVE",
      );
    }
    const [browser] = await tx
      .insert(browserSessions)
      .values({
        id: args.browserId,
        chatThreadId: context.chatThreadId,
        runId: context.runId,
        orgId: context.orgId,
        userId: context.userId,
        name: args.name,
        browserProfileId: args.browserProfileId,
        browserThreadProfileId: args.browserThreadProfileId,
        status: "creating",
        proxyCountryCode: args.proxyCountryCode,
        // Records the provider's hard lifetime cap; Zero's own idle lease is
        // what normally ends a browser well before it.
        timeoutMinutes: ZERO_BROWSER_PROVIDER_TIMEOUT_MINUTES,
      })
      .returning();
    if (!browser) {
      throw new Error("Failed to create managed browser");
    }
    return { kind: "ok", value: browser };
  });
}

const createBrowserForContext$ = command(
  async (
    { set },
    args: {
      readonly context: BrowserRunContext;
      readonly input: BrowserCreateInput;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const profile = await getOrCreateBrowserProfile(db, args.context);
    signal.throwIfAborted();
    if (profile.kind === "error") {
      return profile;
    }
    const claimed = await claimFreshBrowser(
      db,
      args.context,
      {
        ...args.input,
        browserId: randomUUID(),
        browserProfileId: profile.value.compatibilityProfile.id,
        browserThreadProfileId: profile.value.threadProfile.id,
      },
      signal,
    );
    signal.throwIfAborted();
    if (claimed.kind === "error") {
      return claimed;
    }

    const connection = await set(
      startProviderInstance$,
      {
        browser: claimed.value,
        context: args.context,
      },
      AbortSignal.timeout(PROVIDER_START_LIFECYCLE_TIMEOUT_MS),
    );
    signal.throwIfAborted();
    if (connection.kind === "error") {
      await db
        .update(browserSessions)
        .set({ status: "error", updatedAt: nowDate() })
        .where(
          and(
            eq(browserSessions.id, claimed.value.id),
            inArray(browserSessions.status, ["creating", "resuming"]),
          ),
        );
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    return connection;
  },
);

export const createZeroBrowser$ = command(
  async (
    { set },
    args: {
      readonly actor: BrowserActor;
      readonly input: BrowserCreateInput;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const context = await resolveRunContext(db, args.actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    return await set(
      createBrowserForContext$,
      { context: context.value, input: args.input },
      signal,
    );
  },
);

interface InspectActiveConnectionResume {
  readonly kind: "resume";
  readonly browser: BrowserSessionRow;
}

const inspectActiveConnection$ = command(
  async (
    { set },
    args: {
      readonly browser: BrowserSessionRow;
      readonly context: BrowserRunContext;
    },
    signal: AbortSignal,
  ): Promise<
    BrowserServiceResult<BrowserConnection> | InspectActiveConnectionResume
  > => {
    const { browser } = args;
    const db = set(writeDb$);
    const instance = await loadActiveInstance(db, browser.id);
    signal.throwIfAborted();
    if (!instance) {
      const [suspended] = await db
        .update(browserSessions)
        .set({
          status: "suspended",
          suspendedAt: nowDate(),
          suspensionReason: "provider",
          updatedAt: nowDate(),
        })
        .where(eq(browserSessions.id, browser.id))
        .returning();
      signal.throwIfAborted();
      if (!suspended) {
        throw new Error("Failed to suspend managed browser");
      }
      return {
        kind: "resume",
        browser: suspended,
      };
    }
    const provider = await providerCall(
      getBrowserUseSession(instance.providerSessionId, signal),
    );
    signal.throwIfAborted();
    if (provider.kind === "error") {
      return provider;
    }
    const { cdpUrl, liveUrl } = provider.value;
    if (provider.value.status === "active" && cdpUrl && liveUrl) {
      // A later run in the same thread takes the live instance over instead of
      // waiting for it to be reclaimed, and its lease restarts from now.
      const [owner] = await db
        .update(browserSessions)
        .set({ runId: args.context.runId, updatedAt: nowDate() })
        .where(
          and(
            eq(browserSessions.id, browser.id),
            eq(browserSessions.status, "active"),
          ),
        )
        .returning();
      signal.throwIfAborted();
      const leased = await touchInstanceLease(
        db,
        instance.providerSessionId,
        signal,
      );
      return {
        kind: "ok",
        value: {
          browser: publicBrowser(
            owner ?? browser,
            liveUrl,
            leased?.idleExpiresAt ?? instance.idleExpiresAt,
          ),
          cdpUrl,
        },
      };
    }
    await stopActiveBrowserInstance(
      db,
      {
        browserId: browser.id,
        chatThreadId: browser.chatThreadId,
        providerSessionId: instance.providerSessionId,
        userId: browser.userId,
      },
      "provider",
      signal,
      { stopProvider: false },
    );
    signal.throwIfAborted();
    const [suspended] = await db
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, browser.id))
      .limit(1);
    signal.throwIfAborted();
    if (!suspended) {
      throw new Error("Managed browser disappeared during mutation");
    }
    return {
      kind: "resume",
      browser: suspended,
    };
  },
);

type ResumeClaim =
  | { readonly kind: "active"; readonly browser: BrowserSessionRow }
  | { readonly kind: "claimed"; readonly browser: BrowserSessionRow }
  | { readonly kind: "missing" }
  | BrowserServiceError;

async function claimBrowserForResume(
  db: Db,
  context: BrowserRunContext,
  args: {
    readonly expectedBrowserId: string;
    readonly browserProfileId: string | null;
    readonly browserThreadProfileId: string | null;
  },
  signal: AbortSignal,
): Promise<ResumeClaim> {
  return await db.transaction(async (tx) => {
    await lockBrowserThread(tx, context.chatThreadId);
    signal.throwIfAborted();
    const [run] = await tx
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, context.runId))
      .limit(1);
    if (context.requireLiveRun && (!run || isTerminalRunStatus(run.status))) {
      return conflict("The chat run already ended", "BROWSER_RUN_ENDED");
    }
    const owned = await loadOwnedThreadBrowser(tx, context.chatThreadId);
    if (owned) {
      // A live instance is shared across the thread's runs, so ownership no
      // longer decides who may attach to it.
      if (owned.status === "active") {
        return { kind: "active", browser: owned };
      }
      if (["creating", "resuming"].includes(owned.status)) {
        return conflict(
          "The managed browser is already starting",
          "BROWSER_STARTING",
        );
      }
      return conflict(
        "Zero is still reclaiming this thread's previous managed browser; retry in a moment",
        "BROWSER_STOPPING",
      );
    }
    const current = await loadCurrentBrowser(tx, context);
    if (
      !current ||
      current.id !== args.expectedBrowserId ||
      current.browserProfileId !== args.browserProfileId ||
      current.browserThreadProfileId !== args.browserThreadProfileId
    ) {
      return { kind: "missing" };
    }
    const [claimed] = await tx
      .update(browserSessions)
      .set({
        runId: context.runId,
        status: "resuming",
        suspendedAt: null,
        suspensionReason: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.id, current.id),
          inArray(browserSessions.status, ["suspended", "error"]),
        ),
      )
      .returning();
    return claimed
      ? { kind: "claimed", browser: claimed }
      : conflict("The managed browser is busy", "BROWSER_BUSY");
  });
}

type ReuseLiveBrowser =
  | { readonly kind: "resume"; readonly browser: BrowserSessionRow }
  | {
      readonly kind: "connection";
      readonly result: BrowserServiceResult<BrowserConnection>;
    };

// Attach to the thread's live provider instance when it still has one, taking it
// over from whichever run opened it. Returns "resume" when the instance is gone
// and the logical browser has to be restarted instead.
const reuseLiveThreadBrowser$ = command(
  async (
    { set },
    args: {
      readonly context: BrowserRunContext;
      readonly current: BrowserSessionRow;
    },
    signal: AbortSignal,
  ): Promise<ReuseLiveBrowser> => {
    const db = set(writeDb$);
    const owned = await loadOwnedThreadBrowser(db, args.context.chatThreadId);
    signal.throwIfAborted();
    if (!owned) {
      return { kind: "resume", browser: args.current };
    }
    if (owned.status !== "active") {
      return {
        kind: "connection",
        result: ["creating", "resuming"].includes(owned.status)
          ? conflict(
              "The managed browser is already starting",
              "BROWSER_STARTING",
            )
          : conflict(
              "Zero is still reclaiming this thread's previous managed browser; retry in a moment",
              "BROWSER_STOPPING",
            ),
      };
    }
    const inspected = await set(
      inspectActiveConnection$,
      { browser: owned, context: args.context },
      signal,
    );
    return inspected.kind === "resume"
      ? { kind: "resume", browser: inspected.browser }
      : { kind: "connection", result: inspected };
  },
);

const resumeSuspendedBrowser$ = command(
  async (
    { set },
    args: {
      readonly context: BrowserRunContext;
      readonly current: BrowserSessionRow;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const { context, current } = args;

    const claim = await claimBrowserForResume(
      db,
      context,
      {
        expectedBrowserId: current.id,
        browserProfileId: current.browserProfileId,
        browserThreadProfileId: current.browserThreadProfileId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (claim.kind === "error") {
      return claim;
    }
    if (claim.kind === "missing") {
      return conflict(
        "The current managed browser changed; retry resume",
        "BROWSER_CHANGED",
      );
    }
    if (claim.kind === "active") {
      const inspected = await set(
        inspectActiveConnection$,
        { browser: claim.browser, context },
        signal,
      );
      return inspected.kind === "resume"
        ? conflict(
            "The managed browser changed; retry resume",
            "BROWSER_CHANGED",
          )
        : inspected;
    }

    const connection = await set(
      startProviderInstance$,
      { browser: claim.browser, context },
      AbortSignal.timeout(PROVIDER_START_LIFECYCLE_TIMEOUT_MS),
    );
    signal.throwIfAborted();
    if (connection.kind === "error") {
      await db
        .update(browserSessions)
        .set({ status: "error", updatedAt: nowDate() })
        .where(
          and(
            eq(browserSessions.id, claim.browser.id),
            inArray(browserSessions.status, ["creating", "resuming"]),
          ),
        );
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    return connection;
  },
);

// Create, reuse, or resume the thread's browser. A live provider instance is
// reused across runs and its lease restarts; a suspended one is restarted from
// the saved profile, which restores cookies and storage but not the old tabs.
const openBrowserForContext$ = command(
  async (
    { set },
    args: {
      readonly context: BrowserRunContext;
      readonly expectedBrowserId?: string;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const { context } = args;

    const current = await loadCurrentBrowser(db, context);
    signal.throwIfAborted();
    if (!current) {
      return args.expectedBrowserId
        ? notFound()
        : await set(
            createBrowserForContext$,
            {
              context,
              input: {
                name: "browser",
                proxyCountryCode: null,
              },
            },
            signal,
          );
    }
    // A viewer acts on the browser it is looking at. Refuse before touching any
    // provider instance or lease when the thread already moved to a newer one.
    if (args.expectedBrowserId && current.id !== args.expectedBrowserId) {
      return conflict(
        "This chat thread has a newer managed browser; use that one instead",
        "BROWSER_CHANGED",
      );
    }

    const reused = await set(
      reuseLiveThreadBrowser$,
      { context, current },
      signal,
    );
    signal.throwIfAborted();
    return reused.kind === "connection"
      ? reused.result
      : await set(
          resumeSuspendedBrowser$,
          { context, current: reused.browser },
          signal,
        );
  },
);

export const useZeroBrowser$ = command(
  async (
    { set },
    actor: BrowserActor,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const context = await resolveRunContext(db, actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    return await set(
      openBrowserForContext$,
      { context: context.value },
      signal,
    );
  },
);

export const resumeZeroBrowserFromViewer$ = command(
  async (
    { set },
    access: BrowserSessionAccess,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<ZeroBrowserSession>> => {
    const db = set(writeDb$);
    const browser = await loadOwnedBrowser(db, access);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    const context = await resolveViewerContext(db, browser);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    const connection = await set(
      openBrowserForContext$,
      { context: context.value, expectedBrowserId: browser.id },
      signal,
    );
    // The viewer runs in the user's browser, so it only ever learns the live
    // view; the CDP endpoint stays inside the agent runtime.
    return connection.kind === "error"
      ? connection
      : { kind: "ok", value: connection.value.browser };
  },
);

const leaseInstanceForBrowser$ = command(
  async (
    { set },
    browser: BrowserSessionRow,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<ZeroBrowserSession>> => {
    const db = set(writeDb$);
    const instance = await loadActiveInstance(db, browser.id);
    signal.throwIfAborted();
    const leased = instance
      ? await touchInstanceLease(db, instance.providerSessionId, signal)
      : null;
    if (!leased) {
      return conflict(
        "This managed browser is no longer live; resume it to keep working in it",
        "BROWSER_NOT_LIVE",
      );
    }
    return {
      kind: "ok",
      value: publicBrowser(browser, null, leased.idleExpiresAt),
    };
  },
);

export const leaseCurrentZeroBrowser$ = command(
  async (
    { set },
    actor: BrowserActor,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<ZeroBrowserSession>> => {
    const db = set(writeDb$);
    const context = await resolveRunContext(db, actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    const browser = await loadCurrentBrowser(db, context.value);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    return await set(leaseInstanceForBrowser$, browser, signal);
  },
);

export const leaseZeroBrowserById$ = command(
  async (
    { set },
    access: BrowserSessionAccess,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<ZeroBrowserSession>> => {
    const db = set(writeDb$);
    const browser = await loadOwnedBrowser(db, access);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    const context = await resolveViewerContext(db, browser);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    return await set(leaseInstanceForBrowser$, browser, signal);
  },
);

export const getZeroBrowser$ = command(
  async (
    { set },
    access: BrowserSessionAccess,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<ZeroBrowserSession>> => {
    const db = set(writeDb$);
    const row = await loadOwnedBrowser(db, access);
    signal.throwIfAborted();
    if (!row) {
      return notFound();
    }
    const context = await resolveViewerContext(db, row);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    let liveUrl: string | null = null;
    let idleExpiresAt: Date | null = null;
    if (row.status === "active") {
      const instance = await loadActiveInstance(db, row.id);
      signal.throwIfAborted();
      if (instance) {
        idleExpiresAt = instance.idleExpiresAt;
        const provider = await providerCall(
          getBrowserUseSession(instance.providerSessionId, signal),
        );
        signal.throwIfAborted();
        if (provider.kind === "error") {
          return provider;
        }
        liveUrl =
          provider.value.status === "active" ? provider.value.liveUrl : null;
      }
    }
    return { kind: "ok", value: publicBrowser(row, liveUrl, idleExpiresAt) };
  },
);

export const getCurrentZeroBrowser$ = command(
  async (
    { set },
    actor: BrowserActor,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<ZeroBrowserSession>> => {
    const db = set(writeDb$);
    const context = await resolveRunContext(db, actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    const browser = await loadCurrentBrowser(db, context.value);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    return await set(
      getZeroBrowser$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        browserId: browser.id,
        chatThreadId: context.value.chatThreadId,
      },
      signal,
    );
  },
);

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.some((terminalStatus) => {
    return terminalStatus === status;
  });
}

// A terminal run no longer stops its browser: the window stays live so the user
// can keep working in it and the next run can attach to it. Refreshing the lease
// here gives that hand-off a full idle window measured from the run's end.
export const releaseThreadBrowsersForRun$ = command(
  async (
    { set },
    args: { readonly chatThreadId: string },
    signal: AbortSignal,
  ): Promise<BrowserReleaseResult> => {
    const db = set(writeDb$);
    const released = await db
      .update(browserSessionInstances)
      .set({
        lastTouchedAt: nowDate(),
        idleExpiresAt: nextIdleDeadline(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessionInstances.chatThreadId, args.chatThreadId),
          eq(browserSessionInstances.status, "active"),
        ),
      )
      .returning({
        providerSessionId: browserSessionInstances.providerSessionId,
      });
    signal.throwIfAborted();
    return { released: released.length };
  },
);

export const stopThreadZeroBrowsers$ = command(
  async (
    { set },
    args: { readonly chatThreadId: string },
    signal: AbortSignal,
  ): Promise<BrowserReleaseResult> => {
    const db = set(writeDb$);
    await db
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: nowDate(),
        suspensionReason: "reconcile",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, args.chatThreadId),
          inArray(browserSessions.status, ["creating", "resuming"]),
        ),
      );
    signal.throwIfAborted();

    const active = await db
      .select({
        browserId: browserSessions.id,
        chatThreadId: browserSessions.chatThreadId,
        providerSessionId: browserSessionInstances.providerSessionId,
        userId: browserSessions.userId,
      })
      .from(browserSessionInstances)
      .innerJoin(
        browserSessions,
        eq(browserSessions.id, browserSessionInstances.browserSessionId),
      )
      .where(
        and(
          eq(browserSessionInstances.chatThreadId, args.chatThreadId),
          eq(browserSessionInstances.status, "active"),
        ),
      );
    signal.throwIfAborted();

    let released = 0;
    for (const target of active) {
      if (await stopActiveBrowserInstance(db, target, "reconcile", signal)) {
        released += 1;
      }
    }

    await db
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: nowDate(),
        suspensionReason: "reconcile",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, args.chatThreadId),
          eq(browserSessions.status, "active"),
          notExists(
            db
              .select({
                providerSessionId: browserSessionInstances.providerSessionId,
              })
              .from(browserSessionInstances)
              .where(
                and(
                  eq(
                    browserSessionInstances.browserSessionId,
                    browserSessions.id,
                  ),
                  eq(browserSessionInstances.status, "active"),
                ),
              ),
          ),
        ),
      );
    signal.throwIfAborted();
    return { released };
  },
);

async function releaseStrandedBrowserStarts(
  db: Db,
  limit: number,
  signal: AbortSignal,
): Promise<number> {
  const stranded = await db
    .select({
      id: browserSessions.id,
      userId: browserSessions.userId,
    })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.status, "stopping"),
        lte(
          browserSessions.updatedAt,
          new Date(nowDate().getTime() - STRANDED_START_GRACE_MS),
        ),
      ),
    )
    .limit(limit);
  signal.throwIfAborted();
  for (const browser of stranded) {
    await db.transaction(async (tx) => {
      await tx
        .update(browserSessionInstances)
        .set({
          status: "stopped",
          finishedAt: nowDate(),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(browserSessionInstances.browserSessionId, browser.id),
            eq(browserSessionInstances.status, "stopping"),
          ),
        );
      await tx
        .update(browserSessions)
        .set({
          status: "suspended",
          suspendedAt: nowDate(),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(browserSessions.id, browser.id),
            eq(browserSessions.status, "stopping"),
          ),
        );
    });
    await publishBrowserSessionChangedSafely(browser.userId, browser.id);
    signal.throwIfAborted();
  }
  // Nothing stops a browser at run end any more, so a sandbox that dies while
  // its provider instance is starting would otherwise hold the thread's only
  // live-browser slot forever.
  const abandonedStarts = await db
    .update(browserSessions)
    .set({ status: "error", updatedAt: nowDate() })
    .where(
      and(
        inArray(browserSessions.status, ["creating", "resuming"]),
        lte(
          browserSessions.updatedAt,
          new Date(nowDate().getTime() - PROVIDER_START_LIFECYCLE_TIMEOUT_MS),
        ),
        notExists(
          db
            .select({
              providerSessionId: browserSessionInstances.providerSessionId,
            })
            .from(browserSessionInstances)
            .where(
              and(
                eq(
                  browserSessionInstances.browserSessionId,
                  browserSessions.id,
                ),
                eq(browserSessionInstances.status, "active"),
              ),
            ),
        ),
      ),
    )
    .returning({ id: browserSessions.id });
  signal.throwIfAborted();
  return stranded.length + abandonedStarts.length;
}

async function deferBrowserInstanceReconcile(
  db: Db,
  providerSessionId: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .update(browserSessionInstances)
    .set({ updatedAt: nowDate() })
    .where(eq(browserSessionInstances.providerSessionId, providerSessionId));
  signal.throwIfAborted();
}

interface BrowserReconcileCandidate {
  readonly browser: BrowserSessionRow;
  readonly instance: BrowserInstanceRow;
  readonly chatThreadId: string | null;
}

interface BrowserReconcileOutcome {
  readonly stopped: number;
  readonly errors: number;
  readonly healthy: number;
}

const reconcileBrowserInstance$ = command(
  async (
    { set },
    row: BrowserReconcileCandidate,
    signal: AbortSignal,
  ): Promise<BrowserReconcileOutcome> => {
    const db = set(writeDb$);
    let reason: ZeroBrowserSuspensionReason | null = null;
    let stopProvider = true;
    if (row.chatThreadId === null) {
      // Nobody can reach a deleted thread's browser, so reclaim it now instead
      // of leaving it alive until the lease runs out.
      reason = "reconcile";
    } else if (row.instance.timeoutAt <= nowDate()) {
      reason = "timeout";
    } else if (row.instance.idleExpiresAt <= nowDate()) {
      reason = "idle";
    } else {
      const provider = await providerCall(
        getBrowserUseSession(row.instance.providerSessionId, signal),
      );
      signal.throwIfAborted();
      if (provider.kind === "error") {
        await deferBrowserInstanceReconcile(
          db,
          row.instance.providerSessionId,
          signal,
        );
        return { stopped: 0, errors: 1, healthy: 0 };
      }
      if (provider.value.status === "stopped") {
        reason = "provider";
        stopProvider = false;
      }
    }
    if (!reason) {
      await deferBrowserInstanceReconcile(
        db,
        row.instance.providerSessionId,
        signal,
      );
      return { stopped: 0, errors: 0, healthy: 1 };
    }

    const stopped = await stopActiveBrowserInstance(
      db,
      {
        browserId: row.browser.id,
        chatThreadId: row.browser.chatThreadId,
        providerSessionId: row.instance.providerSessionId,
        userId: row.browser.userId,
      },
      reason,
      signal,
      { stopProvider },
    );
    return {
      stopped: stopped ? 1 : 0,
      errors: 0,
      healthy: 0,
    };
  },
);

export const reconcileZeroBrowsers$ = command(
  async ({ set }, signal: AbortSignal): Promise<BrowserReconcileResult> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        browser: browserSessions,
        instance: browserSessionInstances,
        chatThreadId: chatThreads.id,
      })
      .from(browserSessionInstances)
      .innerJoin(
        browserSessions,
        eq(browserSessions.id, browserSessionInstances.browserSessionId),
      )
      .leftJoin(
        chatThreads,
        eq(chatThreads.id, browserSessionInstances.chatThreadId),
      )
      .where(eq(browserSessionInstances.status, "active"))
      .orderBy(browserSessionInstances.updatedAt)
      .limit(RECONCILE_BATCH_SIZE);
    signal.throwIfAborted();

    let stopped = 0;
    let errors = 0;
    let healthy = 0;
    for (const row of rows) {
      const outcome = await set(reconcileBrowserInstance$, row, signal);
      stopped += outcome.stopped;
      errors += outcome.errors;
      healthy += outcome.healthy;
    }

    const releasedStarts = await releaseStrandedBrowserStarts(
      db,
      RECONCILE_BATCH_SIZE,
      signal,
    );

    return {
      checked: rows.length + releasedStarts,
      stopped,
      errors,
      healthy,
    };
  },
);
