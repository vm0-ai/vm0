import { randomUUID } from "node:crypto";

import {
  ZERO_BROWSER_IDLE_LEASE_MINUTES,
  ZERO_BROWSER_INITIAL_SCREEN_HEIGHT,
  ZERO_BROWSER_MAX_SCREEN_HEIGHT,
  ZERO_BROWSER_MIN_SCREEN_HEIGHT,
  ZERO_BROWSER_PROVIDER_TIMEOUT_MINUTES,
  ZERO_BROWSER_SCREEN_WIDTH,
  type ZeroBrowserSession,
  type ZeroBrowserSuspensionReason,
} from "@vm0/api-contracts/contracts/zero-browser";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  browserSessionInstances,
  browserSessionResizeStates,
  browserSessionTabSnapshots,
  browserSessions,
  browserThreadProfiles,
} from "@vm0/db/schema/browser-session";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import { and, asc, desc, eq, inArray, lte, notExists, sql } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  publishBrowserSessionChangedSafely,
  publishChatThreadMessageCreatedSafely,
} from "../external/realtime";
import { nowDate } from "../external/time";
import { settle, settleIncludingAbort } from "../utils";
import {
  BrowserUseProviderError,
  createBrowserUseProfile,
  createBrowserUseSession,
  deleteBrowserUseProfile,
  getBrowserUseSession,
  listBrowserUseTabUrls,
  resizeBrowserUseSession,
  restoreBrowserUseTabUrls,
  stopBrowserUseSession,
  type BrowserUseSession,
} from "./browser-use.service";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";
import {
  activePaidConcurrencySlots,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { insertChatEvent } from "./zero-chat-event.service";

const RECONCILE_BATCH_SIZE = 20;
const PROVIDER_CLEANUP_TIMEOUT_MS = 30_000;
const PROVIDER_START_LIFECYCLE_TIMEOUT_MS = 90_000;
const BROWSER_TAB_SNAPSHOT_TIMEOUT_MS = 10_000;
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
const browserTabSnapshotSchema = z.array(z.string().max(8192)).max(50);

type BrowserSessionRow = typeof browserSessions.$inferSelect;
type BrowserInstanceRow = typeof browserSessionInstances.$inferSelect;
type BrowserThreadProfileRow = typeof browserThreadProfiles.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

class BrowserStartedEventIdConflictError extends Error {}

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
  readonly lifecycleEventId: string | null;
}

interface BrowserMutation {
  readonly browser: ZeroBrowserSession;
  readonly lifecycleEventId: string | null;
}

interface BrowserScreen {
  readonly width: typeof ZERO_BROWSER_SCREEN_WIDTH;
  readonly height: number;
  readonly resizable: true;
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

interface BrowserOwnerAccess {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
}

interface BrowserSessionAccess extends BrowserOwnerAccess {
  readonly chatThreadId: string;
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

function browserViewerUrl(chatThreadId: string): string {
  return `${env("APP_URL").replace(/\/+$/u, "")}/browsers/${chatThreadId}`;
}

function publicBrowser(
  row: BrowserSessionRow,
  liveUrl: string | null,
  idleExpiresAt: Date | null = null,
  screen: BrowserScreen | null = null,
): ZeroBrowserSession {
  return {
    threadId: row.chatThreadId,
    name: row.name,
    status: row.status,
    viewerUrl: browserViewerUrl(row.chatThreadId),
    liveUrl,
    proxyCountryCode: row.proxyCountryCode,
    timeoutMinutes: row.timeoutMinutes,
    ...(screen ? { screen } : {}),
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

function browserScreenHeightForAspectRatio(aspectRatio: number): number {
  return Math.min(
    Math.max(
      Math.round(ZERO_BROWSER_SCREEN_WIDTH / aspectRatio),
      ZERO_BROWSER_MIN_SCREEN_HEIGHT,
    ),
    ZERO_BROWSER_MAX_SCREEN_HEIGHT,
  );
}

async function loadBrowserScreen(
  db: Db,
  providerSessionId: string,
  signal: AbortSignal,
): Promise<BrowserScreen | null> {
  const [screen] = await db
    .select({
      width: browserSessionResizeStates.screenWidth,
      height: browserSessionResizeStates.screenHeight,
    })
    .from(browserSessionResizeStates)
    .where(eq(browserSessionResizeStates.providerSessionId, providerSessionId))
    .limit(1);
  signal.throwIfAborted();
  return screen?.width === ZERO_BROWSER_SCREEN_WIDTH
    ? {
        width: ZERO_BROWSER_SCREEN_WIDTH,
        height: screen.height,
        resizable: true,
      }
    : null;
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

async function persistBrowserScreen(
  db: Db,
  providerSessionId: string,
  screenHeight: number,
  signal: AbortSignal,
): Promise<
  BrowserServiceResult<{
    readonly instance: BrowserInstanceRow;
    readonly screen: BrowserScreen;
  }>
> {
  const [updatedScreen] = await db
    .update(browserSessionResizeStates)
    .set({
      screenWidth: ZERO_BROWSER_SCREEN_WIDTH,
      screenHeight,
      updatedAt: nowDate(),
    })
    .where(eq(browserSessionResizeStates.providerSessionId, providerSessionId))
    .returning({ height: browserSessionResizeStates.screenHeight });
  signal.throwIfAborted();
  if (!updatedScreen) {
    return conflict(
      "This managed browser was started before window resizing was enabled; resume it before resizing it",
      "BROWSER_RESIZE_UNSUPPORTED",
    );
  }
  const instance = await touchInstanceLease(db, providerSessionId, signal);
  if (!instance) {
    return conflict(
      "This managed browser is no longer live; resume it before resizing it",
      "BROWSER_NOT_LIVE",
    );
  }
  return {
    kind: "ok",
    value: {
      instance,
      screen: {
        width: ZERO_BROWSER_SCREEN_WIDTH,
        height: updatedScreen.height,
        resizable: true,
      },
    },
  };
}

async function createBrowserScreenState(
  tx: DbTransaction,
  providerSessionId: string,
): Promise<BrowserScreen> {
  const [resizeState] = await tx
    .insert(browserSessionResizeStates)
    .values({
      providerSessionId,
      screenWidth: ZERO_BROWSER_SCREEN_WIDTH,
      screenHeight: ZERO_BROWSER_INITIAL_SCREEN_HEIGHT,
    })
    .returning({ height: browserSessionResizeStates.screenHeight });
  if (!resizeState) {
    throw new Error("Failed to persist managed browser resize state");
  }
  return {
    width: ZERO_BROWSER_SCREEN_WIDTH,
    height: resizeState.height,
    resizable: true,
  };
}

interface ActiveBrowserInstance {
  readonly chatThreadId: string;
  readonly providerSessionId: string;
  readonly userId: string;
}

async function saveBrowserTabSnapshot(
  db: Db,
  target: ActiveBrowserInstance,
  signal: AbortSignal,
): Promise<void> {
  const snapshotSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(BROWSER_TAB_SNAPSHOT_TIMEOUT_MS),
  ]);
  const saved = await settle(
    (async () => {
      const provider = await getBrowserUseSession(
        target.providerSessionId,
        snapshotSignal,
      );
      snapshotSignal.throwIfAborted();
      if (provider.status !== "active" || !provider.cdpUrl) {
        return;
      }
      const urls = await listBrowserUseTabUrls(provider.cdpUrl, snapshotSignal);
      snapshotSignal.throwIfAborted();
      const encryptedTabUrls = await encryptPersistentSecretValue(
        JSON.stringify(urls),
        { userId: target.userId },
      );
      snapshotSignal.throwIfAborted();
      await db
        .insert(browserSessionTabSnapshots)
        .values({
          chatThreadId: target.chatThreadId,
          encryptedTabUrls,
        })
        .onConflictDoUpdate({
          target: browserSessionTabSnapshots.chatThreadId,
          set: {
            encryptedTabUrls,
            updatedAt: nowDate(),
          },
        });
      snapshotSignal.throwIfAborted();
    })(),
  );
  signal.throwIfAborted();
  if (!saved.ok) {
    L.warn("Managed browser tab snapshot failed", {
      chatThreadId: target.chatThreadId,
    });
  }
}

async function restoreBrowserTabSnapshot(
  db: Db,
  browser: BrowserSessionRow,
  cdpUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const restored = await settle(
    (async () => {
      const [snapshot] = await db
        .select({
          encryptedTabUrls: browserSessionTabSnapshots.encryptedTabUrls,
        })
        .from(browserSessionTabSnapshots)
        .where(
          eq(browserSessionTabSnapshots.chatThreadId, browser.chatThreadId),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!snapshot) {
        return;
      }
      const urls = browserTabSnapshotSchema.parse(
        JSON.parse(
          await decryptPersistentSecretValue(snapshot.encryptedTabUrls, {
            userId: browser.userId,
          }),
        ) as unknown,
      );
      signal.throwIfAborted();
      await restoreBrowserUseTabUrls(cdpUrl, urls, signal);
    })(),
  );
  signal.throwIfAborted();
  if (!restored.ok) {
    L.warn("Managed browser tab restoration failed", {
      chatThreadId: browser.chatThreadId,
    });
  }
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
  options: {
    readonly stopProvider: boolean;
    readonly lifecycleEventId?: string;
    readonly emitLifecycleEvent?: boolean;
    readonly saveTabSnapshot?: boolean;
  } = { stopProvider: true },
): Promise<{ readonly lifecycleEventId: string | null } | null> {
  if (options.saveTabSnapshot ?? options.stopProvider) {
    await saveBrowserTabSnapshot(db, target, signal);
  }
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
      return null;
    }
    await tx
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: nowDate(),
        suspensionReason: reason,
        updatedAt: nowDate(),
      })
      .where(eq(browserSessions.chatThreadId, target.chatThreadId));
    if (options.emitLifecycleEvent === false) {
      return { eventId: null, seqId: null };
    }
    const lifecycleEventId = options.lifecycleEventId ?? randomUUID();
    const event = await insertChatEvent(
      tx,
      {
        id: lifecycleEventId,
        chatThreadId: target.chatThreadId,
        eventType: "browser.stopped",
        content: null,
      },
      "id",
    );
    if (!event) {
      throw new Error("Failed to persist managed browser stopped event");
    }
    return { eventId: event.id, seqId: event.seqId };
  });
  if (stopped && options.stopProvider) {
    stopProviderSessionLater(target.providerSessionId);
  }
  signal.throwIfAborted();
  if (!stopped) {
    return null;
  }
  await publishBrowserSessionChangedSafely(target.userId, {
    threadId: target.chatThreadId,
  });
  if (stopped.eventId !== null && stopped.seqId !== null) {
    await publishChatThreadMessageCreatedSafely(
      target.userId,
      target.chatThreadId,
      stopped.seqId,
    );
  }
  signal.throwIfAborted();
  return { lifecycleEventId: stopped.eventId };
}

async function suspendBrowserWithoutActiveInstance(
  db: Db,
  browser: BrowserSessionRow,
  reason: ZeroBrowserSuspensionReason,
  lifecycleEventId: string,
  signal: AbortSignal,
): Promise<BrowserSessionRow | null> {
  const suspendedResult = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, browser.chatThreadId);
    const [suspended] = await tx
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: nowDate(),
        suspensionReason: reason,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, browser.chatThreadId),
          eq(browserSessions.status, "active"),
        ),
      )
      .returning();
    if (!suspended) {
      return null;
    }
    const event = await insertChatEvent(
      tx,
      {
        id: lifecycleEventId,
        chatThreadId: browser.chatThreadId,
        eventType: "browser.stopped",
        content: null,
      },
      "id",
    );
    if (!event) {
      throw new Error("Failed to persist managed browser stopped event");
    }
    return { suspended, event };
  });
  signal.throwIfAborted();
  if (!suspendedResult) {
    return null;
  }
  await Promise.all([
    publishBrowserSessionChangedSafely(browser.userId, {
      threadId: browser.chatThreadId,
    }),
    publishChatThreadMessageCreatedSafely(
      browser.userId,
      browser.chatThreadId,
      suspendedResult.event.seqId,
    ),
  ]);
  signal.throwIfAborted();
  return suspendedResult.suspended;
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
      chatThreadId: browserSessions.chatThreadId,
      providerSessionId: browserSessionInstances.providerSessionId,
      userId: browserSessions.userId,
    })
    .from(browserSessionInstances)
    .innerJoin(
      browserSessions,
      eq(browserSessions.chatThreadId, browserSessionInstances.chatThreadId),
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

async function resolveViewerStartContext(
  db: Db,
  access: BrowserSessionAccess,
): Promise<BrowserServiceResult<BrowserRunContext>> {
  if (access.runId) {
    const context = await resolveRunContext(db, access);
    if (context.kind === "error") {
      return context;
    }
    return context.value.chatThreadId === access.chatThreadId
      ? context
      : notFound();
  }
  const [thread] = await db
    .select({
      id: chatThreads.id,
      browserRunId: browserSessions.runId,
    })
    .from(chatThreads)
    .innerJoin(agentComposes, eq(agentComposes.id, chatThreads.agentComposeId))
    .leftJoin(browserSessions, eq(browserSessions.chatThreadId, chatThreads.id))
    .where(
      and(
        eq(chatThreads.id, access.chatThreadId),
        eq(chatThreads.userId, access.userId),
        eq(agentComposes.orgId, access.orgId),
      ),
    )
    .limit(1);
  if (!thread) {
    return notFound();
  }
  const latestRunId =
    (await latestThreadRunId(db, access.chatThreadId)) ?? thread.browserRunId;
  if (!latestRunId) {
    return conflict(
      "This browser's chat thread has no run; send a message first",
      "BROWSER_RUN_REQUIRED",
    );
  }
  return {
    kind: "ok",
    value: {
      orgId: access.orgId,
      userId: access.userId,
      runId: latestRunId,
      chatThreadId: access.chatThreadId,
      requireLiveRun: false,
    },
  };
}

async function browserSessionAccessError(
  db: Db,
  browser: BrowserSessionRow,
  access: BrowserOwnerAccess,
): Promise<BrowserServiceError | null> {
  // Session callers are authorized by ownership. Run-scoped callers must also
  // belong to this thread and retain its agent browser authorization.
  if (!access.runId) {
    return null;
  }
  const [run] = await db
    .select({
      chatThreadId: zeroRuns.chatThreadId,
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
    .where(
      and(
        eq(zeroRuns.id, access.runId),
        eq(agentRuns.orgId, access.orgId),
        eq(agentRuns.userId, access.userId),
      ),
    )
    .limit(1);
  if (!run?.chatThreadId || run.chatThreadId !== browser.chatThreadId) {
    return notFound();
  }
  if (!run.cloudBrowserEnabled) {
    return serviceError(
      403,
      "BROWSER_AUTHORIZATION_REQUIRED",
      "Cloud browser is not enabled for this chat thread",
    );
  }
  return null;
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
        eq(browserSessions.chatThreadId, access.chatThreadId),
        eq(browserSessions.orgId, access.orgId),
        eq(browserSessions.userId, access.userId),
        eq(chatThreads.userId, access.userId),
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
    .limit(1);
  return row ?? null;
}

async function loadActiveInstance(
  db: Db,
  chatThreadId: string,
): Promise<BrowserInstanceRow | null> {
  const [row] = await db
    .select()
    .from(browserSessionInstances)
    .where(
      and(
        eq(browserSessionInstances.chatThreadId, chatThreadId),
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

async function loadBrowserProfileForBrowser(
  db: Db,
  browser: BrowserSessionRow,
): Promise<BrowserThreadProfileRow> {
  const [row] = await db
    .select()
    .from(browserThreadProfiles)
    .where(
      and(
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

async function getOrCreateBrowserProfile(
  db: Db,
  context: BrowserRunContext,
): Promise<BrowserServiceResult<BrowserThreadProfileRow>> {
  const existing = await loadOwnedThreadBrowserProfile(db, context);
  if (existing) {
    return { kind: "ok", value: existing };
  }

  let createdProviderProfileId: string | null = null;
  let retainedCreatedProfile = false;
  const transaction = await settle(
    db.transaction(async (tx) => {
      await lockBrowserProfileCreation(tx, context.chatThreadId);
      const lockedExisting = await loadOwnedThreadBrowserProfile(tx, context);
      if (lockedExisting) {
        return { kind: "ok" as const, value: lockedExisting };
      }

      const provider = await providerCall(
        createBrowserUseProfile(
          context.chatThreadId,
          AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
        ),
      );
      if (provider.kind === "error") {
        return provider;
      }
      createdProviderProfileId = provider.value;

      const claimed = await claimBrowserProfile(tx, {
        orgId: context.orgId,
        userId: context.userId,
        chatThreadId: context.chatThreadId,
        providerProfileId: provider.value,
      });
      retainedCreatedProfile = claimed.created;
      return { kind: "ok" as const, value: claimed.profile };
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

async function persistStartedProviderInstance(
  tx: DbTransaction,
  args: {
    readonly current: BrowserSessionRow;
    readonly provider: BrowserUseSession;
    readonly runId: string;
    readonly cleanupAfterStart: boolean;
  },
) {
  const status = args.cleanupAfterStart ? "stopped" : "active";
  const stopRequestedAt = args.cleanupAfterStart ? nowDate() : null;
  const finishedAt = args.cleanupAfterStart ? nowDate() : null;
  const [instance] = await tx
    .insert(browserSessionInstances)
    .values({
      providerSessionId: args.provider.id,
      chatThreadId: args.current.chatThreadId,
      runId: args.runId,
      status,
      timeoutAt: new Date(args.provider.timeoutAt),
      startedAt: new Date(args.provider.startedAt),
      lastTouchedAt: nowDate(),
      idleExpiresAt: nextIdleDeadline(),
      stopRequestedAt,
      finishedAt,
    })
    .returning();
  if (!instance) {
    throw new Error("Failed to persist managed browser provider instance");
  }
  const screen = !args.cleanupAfterStart
    ? await createBrowserScreenState(tx, instance.providerSessionId)
    : null;
  return { instance, screen };
}

async function claimStartedProviderInstance(
  db: Db,
  args: {
    readonly browser: BrowserSessionRow;
    readonly context: BrowserRunContext;
    readonly provider: BrowserUseSession;
    readonly lifecycleEventId: string;
  },
) {
  const claimed = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, args.context.chatThreadId);
    const [current] = await tx
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.chatThreadId, args.browser.chatThreadId))
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
    const { instance, screen } = await persistStartedProviderInstance(tx, {
      current,
      provider: args.provider,
      runId: args.context.runId,
      cleanupAfterStart,
    });
    if (cleanupAfterStart) {
      const [browser] = await tx
        .update(browserSessions)
        .set({
          status: "suspended",
          suspendedAt: nowDate(),
          suspensionReason: current.suspensionReason ?? "reconcile",
          updatedAt: nowDate(),
        })
        .where(eq(browserSessions.chatThreadId, current.chatThreadId))
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
      .where(eq(browserSessions.chatThreadId, current.chatThreadId))
      .returning();
    if (!browser) {
      throw new Error("Failed to activate managed browser");
    }
    const event = await insertChatEvent(
      tx,
      {
        id: args.lifecycleEventId,
        chatThreadId: current.chatThreadId,
        eventType: "browser.started",
        content: null,
      },
      "id",
    );
    if (!event) {
      throw new BrowserStartedEventIdConflictError(
        "Managed browser start event ID is already in use",
      );
    }
    return {
      kind: "active" as const,
      browser,
      instance,
      screen,
      lifecycleEvent: event,
    };
  });
  if (claimed.kind === "cleanup" || claimed.kind === "active") {
    await publishBrowserSessionChangedSafely(args.browser.userId, {
      threadId: args.browser.chatThreadId,
    });
  }
  if (claimed.kind === "active") {
    await publishChatThreadMessageCreatedSafely(
      args.browser.userId,
      args.browser.chatThreadId,
      claimed.lifecycleEvent.seqId,
    );
  }
  return claimed;
}

async function createAndClaimProviderInstance(
  db: Db,
  args: {
    readonly browser: BrowserSessionRow;
    readonly profile: Pick<BrowserThreadProfileRow, "providerProfileId">;
    readonly context: BrowserRunContext;
    readonly lifecycleEventId: string;
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

  const claimResult = await settleIncludingAbort(
    claimStartedProviderInstance(db, {
      browser: args.browser,
      context: args.context,
      provider: provider.value,
      lifecycleEventId: args.lifecycleEventId,
    }),
  );
  if (!claimResult.ok) {
    // Provider creation is irreversible. Any failed claim must reclaim the
    // provider because the transaction rolls back every durable owner row.
    stopProviderSessionLater(provider.value.id);
    if (claimResult.error instanceof BrowserStartedEventIdConflictError) {
      return conflict(
        "The managed browser lifecycle event ID is already in use",
        "BROWSER_EVENT_ID_CONFLICT",
      );
    }
    throw claimResult.error;
  }
  const claimed = claimResult.value;
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
      readonly lifecycleEventId: string;
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
      lifecycleEventId: args.lifecycleEventId,
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

    await restoreBrowserTabSnapshot(
      db,
      claimed.browser,
      started.cdpUrl,
      signal,
    );

    return {
      kind: "ok",
      value: {
        browser: publicBrowser(
          claimed.browser,
          started.liveUrl,
          claimed.instance.idleExpiresAt,
          claimed.screen,
        ),
        cdpUrl: started.cdpUrl,
        lifecycleEventId: claimed.lifecycleEvent.id,
      },
    };
  },
);

async function claimFreshBrowser(
  db: Db,
  context: BrowserRunContext,
  args: BrowserCreateInput,
  signal: AbortSignal,
): Promise<BrowserServiceResult<BrowserSessionRow>> {
  return await db.transaction(async (tx) => {
    await lockBrowserThread(tx, context.chatThreadId);
    signal.throwIfAborted();
    const [owned, run] = await Promise.all([
      tx
        .select({ chatThreadId: browserSessions.chatThreadId })
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
        chatThreadId: context.chatThreadId,
        runId: context.runId,
        orgId: context.orgId,
        userId: context.userId,
        name: args.name,
        status: "creating",
        proxyCountryCode: args.proxyCountryCode,
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
      readonly lifecycleEventId: string;
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
      args.input,
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
        lifecycleEventId: args.lifecycleEventId,
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
            eq(browserSessions.chatThreadId, claimed.value.chatThreadId),
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
      openBrowserForContext$,
      {
        context: context.value,
        input: args.input,
        lifecycleEventId: randomUUID(),
      },
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
    const instance = await loadActiveInstance(db, browser.chatThreadId);
    signal.throwIfAborted();
    if (!instance) {
      const suspended = await suspendBrowserWithoutActiveInstance(
        db,
        browser,
        "provider",
        randomUUID(),
        signal,
      );
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
            eq(browserSessions.chatThreadId, browser.chatThreadId),
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
      const screen = await loadBrowserScreen(
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
            screen,
          ),
          cdpUrl,
          lifecycleEventId: null,
        },
      };
    }
    await stopActiveBrowserInstance(
      db,
      {
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
      .where(eq(browserSessions.chatThreadId, browser.chatThreadId))
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
    if (!current) {
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
          eq(browserSessions.chatThreadId, current.chatThreadId),
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
      readonly lifecycleEventId: string;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const { context } = args;

    const claim = await claimBrowserForResume(db, context, signal);
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
      {
        browser: claim.browser,
        context,
        lifecycleEventId: args.lifecycleEventId,
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
            eq(browserSessions.chatThreadId, claim.browser.chatThreadId),
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
// the saved profile and its last captured HTTP(S) tab URLs are reopened on a
// best-effort basis.
const openBrowserForContext$ = command(
  async (
    { set },
    args: {
      readonly context: BrowserRunContext;
      readonly lifecycleEventId: string;
      readonly input?: BrowserCreateInput;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const { context } = args;

    const current = await loadCurrentBrowser(db, context);
    signal.throwIfAborted();
    if (!current) {
      return await set(
        createBrowserForContext$,
        {
          context,
          input: args.input ?? {
            name: "browser",
            proxyCountryCode: null,
          },
          lifecycleEventId: args.lifecycleEventId,
        },
        signal,
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
          {
            context,
            current: reused.browser,
            lifecycleEventId: args.lifecycleEventId,
          },
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
      {
        context: context.value,
        lifecycleEventId: randomUUID(),
      },
      signal,
    );
  },
);

export const startZeroBrowserForThread$ = command(
  async (
    { set },
    args: BrowserSessionAccess & { readonly lifecycleEventId: string },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserMutation>> => {
    const db = set(writeDb$);
    const context = await resolveViewerStartContext(db, args);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    const connection = await set(
      openBrowserForContext$,
      {
        context: context.value,
        lifecycleEventId: args.lifecycleEventId,
      },
      signal,
    );
    // The viewer runs in the user's browser, so it only ever learns the live
    // view; the CDP endpoint stays inside the agent runtime.
    return connection.kind === "error"
      ? connection
      : {
          kind: "ok",
          value: {
            browser: connection.value.browser,
            lifecycleEventId: connection.value.lifecycleEventId,
          },
        };
  },
);

export const stopZeroBrowserForThread$ = command(
  async (
    { set },
    args: BrowserSessionAccess & { readonly lifecycleEventId: string },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserMutation>> => {
    const db = set(writeDb$);
    const browser = await loadOwnedBrowser(db, args);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    const accessError = await browserSessionAccessError(db, browser, args);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    if (browser.status !== "active") {
      return {
        kind: "ok",
        value: {
          browser: publicBrowser(browser, null),
          lifecycleEventId: null,
        },
      };
    }
    const instance = await loadActiveInstance(db, browser.chatThreadId);
    signal.throwIfAborted();
    if (!instance) {
      const suspended = await suspendBrowserWithoutActiveInstance(
        db,
        browser,
        "user",
        args.lifecycleEventId,
        signal,
      );
      if (!suspended) {
        return conflict("The managed browser is busy", "BROWSER_BUSY");
      }
      return {
        kind: "ok",
        value: {
          browser: publicBrowser(suspended, null),
          lifecycleEventId: args.lifecycleEventId,
        },
      };
    }
    const stopped = await stopActiveBrowserInstance(
      db,
      {
        chatThreadId: browser.chatThreadId,
        providerSessionId: instance.providerSessionId,
        userId: browser.userId,
      },
      "user",
      signal,
      {
        stopProvider: true,
        lifecycleEventId: args.lifecycleEventId,
      },
    );
    if (!stopped?.lifecycleEventId) {
      return conflict("The managed browser is busy", "BROWSER_BUSY");
    }
    const stoppedBrowser = await loadOwnedBrowser(db, args);
    signal.throwIfAborted();
    if (!stoppedBrowser) {
      throw new Error("Managed browser disappeared during stop");
    }
    return {
      kind: "ok",
      value: {
        browser: publicBrowser(stoppedBrowser, null),
        lifecycleEventId: stopped.lifecycleEventId,
      },
    };
  },
);

const leaseInstanceForBrowser$ = command(
  async (
    { set },
    browser: BrowserSessionRow,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<ZeroBrowserSession>> => {
    const db = set(writeDb$);
    const instance = await loadActiveInstance(db, browser.chatThreadId);
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
    const screen = await loadBrowserScreen(
      db,
      leased.providerSessionId,
      signal,
    );
    return {
      kind: "ok",
      value: publicBrowser(browser, null, leased.idleExpiresAt, screen),
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

export const leaseZeroBrowserByThread$ = command(
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
    const accessError = await browserSessionAccessError(db, browser, access);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    return await set(leaseInstanceForBrowser$, browser, signal);
  },
);

export const resizeZeroBrowserByThread$ = command(
  async (
    { set },
    access: BrowserSessionAccess & { readonly aspectRatio: number },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<ZeroBrowserSession>> => {
    const db = set(writeDb$);
    const browser = await loadOwnedBrowser(db, access);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    const accessError = await browserSessionAccessError(db, browser, access);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    if (browser.status !== "active") {
      return conflict(
        "This managed browser is no longer live; resume it before resizing it",
        "BROWSER_NOT_LIVE",
      );
    }
    const instance = await loadActiveInstance(db, browser.chatThreadId);
    signal.throwIfAborted();
    if (!instance) {
      return conflict(
        "This managed browser is no longer live; resume it before resizing it",
        "BROWSER_NOT_LIVE",
      );
    }
    const screen = await loadBrowserScreen(
      db,
      instance.providerSessionId,
      signal,
    );
    if (!screen) {
      return conflict(
        "This managed browser was started before window resizing was enabled; resume it before resizing it",
        "BROWSER_RESIZE_UNSUPPORTED",
      );
    }
    const touched = await touchInstanceLease(
      db,
      instance.providerSessionId,
      signal,
    );
    if (!touched) {
      return conflict(
        "This managed browser is no longer live; resume it before resizing it",
        "BROWSER_NOT_LIVE",
      );
    }
    const provider = await providerCall(
      getBrowserUseSession(instance.providerSessionId, signal),
    );
    signal.throwIfAborted();
    if (provider.kind === "error") {
      return provider;
    }
    if (provider.value.status !== "active" || !provider.value.cdpUrl) {
      return conflict(
        "This managed browser is no longer live; resume it before resizing it",
        "BROWSER_NOT_LIVE",
      );
    }
    const screenHeight = browserScreenHeightForAspectRatio(access.aspectRatio);
    const resized = await providerCall(
      resizeBrowserUseSession(
        provider.value.cdpUrl,
        ZERO_BROWSER_SCREEN_WIDTH,
        screenHeight,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (resized.kind === "error") {
      return resized;
    }
    const persisted = await persistBrowserScreen(
      db,
      instance.providerSessionId,
      screenHeight,
      signal,
    );
    if (persisted.kind === "error") {
      return persisted;
    }
    await publishBrowserSessionChangedSafely(browser.userId, {
      threadId: browser.chatThreadId,
    });
    signal.throwIfAborted();
    return {
      kind: "ok",
      value: publicBrowser(
        browser,
        provider.value.liveUrl,
        persisted.value.instance.idleExpiresAt,
        persisted.value.screen,
      ),
    };
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
    const accessError = await browserSessionAccessError(db, row, access);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    let liveUrl: string | null = null;
    let idleExpiresAt: Date | null = null;
    let screen: BrowserScreen | null = null;
    if (row.status === "active") {
      const instance = await loadActiveInstance(db, row.chatThreadId);
      signal.throwIfAborted();
      if (instance) {
        idleExpiresAt = instance.idleExpiresAt;
        screen = await loadBrowserScreen(
          db,
          instance.providerSessionId,
          signal,
        );
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
    return {
      kind: "ok",
      value: publicBrowser(row, liveUrl, idleExpiresAt, screen),
    };
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
        chatThreadId: browserSessions.chatThreadId,
        providerSessionId: browserSessionInstances.providerSessionId,
        userId: browserSessions.userId,
      })
      .from(browserSessionInstances)
      .innerJoin(
        browserSessions,
        eq(browserSessions.chatThreadId, browserSessionInstances.chatThreadId),
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
      if (
        await stopActiveBrowserInstance(db, target, "reconcile", signal, {
          stopProvider: true,
          emitLifecycleEvent: false,
          saveTabSnapshot: false,
        })
      ) {
        released += 1;
      }
    }

    await db
      .delete(browserSessionTabSnapshots)
      .where(eq(browserSessionTabSnapshots.chatThreadId, args.chatThreadId));
    signal.throwIfAborted();

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
                    browserSessionInstances.chatThreadId,
                    browserSessions.chatThreadId,
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
      chatThreadId: browserSessions.chatThreadId,
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
            eq(browserSessionInstances.chatThreadId, browser.chatThreadId),
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
            eq(browserSessions.chatThreadId, browser.chatThreadId),
            eq(browserSessions.status, "stopping"),
          ),
        );
    });
    await publishBrowserSessionChangedSafely(browser.userId, {
      threadId: browser.chatThreadId,
    });
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
                  browserSessionInstances.chatThreadId,
                  browserSessions.chatThreadId,
                ),
                eq(browserSessionInstances.status, "active"),
              ),
            ),
        ),
      ),
    )
    .returning({ chatThreadId: browserSessions.chatThreadId });
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
        chatThreadId: row.browser.chatThreadId,
        providerSessionId: row.instance.providerSessionId,
        userId: row.browser.userId,
      },
      reason,
      signal,
      {
        stopProvider,
        emitLifecycleEvent: row.chatThreadId !== null,
      },
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
        eq(browserSessions.chatThreadId, browserSessionInstances.chatThreadId),
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
