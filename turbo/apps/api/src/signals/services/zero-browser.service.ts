import { randomUUID } from "node:crypto";

import {
  ZERO_BROWSER_DEFAULT_MAX_CREDITS,
  ZERO_BROWSER_DEFAULT_TIMEOUT_MINUTES,
  type ZeroBrowserSession,
  type ZeroBrowserSuspensionReason,
} from "@vm0/api-contracts/contracts/zero-browser";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  browserProfiles,
  browserSessionInstances,
  browserSessions,
} from "@vm0/db/schema/browser-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import {
  BrowserUseProviderError,
  createBrowserUseProfile,
  createBrowserUseSession,
  deleteBrowserUseProfile,
  getBrowserUseSession,
  stopBrowserUseSession,
  type BrowserUseSession,
} from "./browser-use.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";
import { checkCreditAmount$ } from "./zero-managed-usage.service";

const BROWSER_USAGE_KIND = "browser";
const BROWSER_USAGE_PROVIDER = "browser-use";
const BROWSER_USAGE_CATEGORY = "provider_cost_usd_micros";
const MAX_ACTIVE_BROWSER_SESSIONS_PER_ORG = 3;
const RECONCILE_BATCH_SIZE = 20;
const PROVIDER_CLEANUP_TIMEOUT_MS = 30_000;
const PROVIDER_START_LIFECYCLE_TIMEOUT_MS = 90_000;
const STRANDED_START_GRACE_MS = 60_000;
const OWNED_BROWSER_STATUSES = [
  "creating",
  "active",
  "resuming",
  "stopping",
] as const;
const CLEANUP_INSTANCE_STATUSES = ["active", "stopping", "stopped"] as const;
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;

type BrowserSessionRow = typeof browserSessions.$inferSelect;
type BrowserInstanceRow = typeof browserSessionInstances.$inferSelect;
type BrowserProfileRow = typeof browserProfiles.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface BrowserServiceError {
  readonly kind: "error";
  readonly status: 400 | 402 | 404 | 409 | 502 | 503;
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
  readonly runId: string;
  readonly chatThreadId: string;
}

interface BrowserCreateInput {
  readonly name: string;
  readonly proxyCountryCode: string | null;
  readonly timeoutMinutes: number;
  readonly maxCredits: number;
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

interface BrowserPricing {
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface ClaimedBrowserInstance {
  readonly browser: BrowserSessionRow;
  readonly instance: BrowserInstanceRow;
  readonly reason: ZeroBrowserSuspensionReason;
}

interface BrowserFinalizeResult {
  readonly checked: number;
  readonly stopped: number;
  readonly settled: number;
  readonly errors: number;
}

interface BrowserReconcileResult extends BrowserFinalizeResult {
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
    const issueSummary = error.issues
      .slice(0, 8)
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    return serviceError(
      502,
      "BROWSER_USE_INVALID_RESPONSE",
      `Managed browser provider returned an invalid response (${issueSummary})`,
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
): ZeroBrowserSession {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    viewerUrl: browserViewerUrl(row.id),
    liveUrl,
    proxyCountryCode: row.proxyCountryCode,
    timeoutMinutes: row.timeoutMinutes,
    maxCredits: row.maxCredits,
    grossCredits: row.grossCredits,
    creditsCharged: row.creditsCharged,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    suspensionReason: row.suspensionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function decimalParts(value: string): {
  readonly digits: bigint;
  readonly scale: number;
} {
  if (value.length > 64 || !/^\d+(?:\.\d+)?$/u.test(value)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "Invalid provider cost",
        input: value,
      },
    ]);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return {
    digits: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function providerUsdToMicrousd(values: readonly string[]): number {
  const parts = values.map(decimalParts);
  const maxScale = Math.max(
    0,
    ...parts.map((part) => {
      return part.scale;
    }),
  );
  const divisor = 10n ** BigInt(maxScale);
  const total = parts.reduce((sum, part) => {
    return sum + part.digits * 10n ** BigInt(maxScale - part.scale);
  }, 0n);
  const micros = (total * 1_000_000n + divisor - 1n) / divisor;
  const numberValue = Number(micros);
  if (!Number.isSafeInteger(numberValue)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "Provider cost exceeds supported range",
        input: values,
      },
    ]);
  }
  return numberValue;
}

async function loadBrowserPricing(db: Db): Promise<BrowserPricing | null> {
  const [pricing] = await db
    .select({
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, BROWSER_USAGE_KIND),
        eq(usagePricing.provider, BROWSER_USAGE_PROVIDER),
        eq(usagePricing.category, BROWSER_USAGE_CATEGORY),
      ),
    )
    .limit(1);
  if (!pricing || pricing.unitSize <= 0 || pricing.unitPrice < 0) {
    return null;
  }
  return pricing;
}

function grossCreditsForCost(
  pricing: BrowserPricing,
  providerCostMicrousd: number,
): number | null {
  if (providerCostMicrousd === 0) {
    return 0;
  }
  const credits =
    (BigInt(providerCostMicrousd) * BigInt(pricing.unitPrice) +
      BigInt(pricing.unitSize) -
      1n) /
    BigInt(pricing.unitSize);
  const value = Number(credits);
  return Number.isSafeInteger(value) ? value : null;
}

async function cappedInstanceGrossCredits(
  db: Db,
  browser: BrowserSessionRow,
  instance: BrowserInstanceRow,
  providerGrossCredits: number,
  signal: AbortSignal,
): Promise<number> {
  const priorInstances = await db
    .select({ grossCredits: browserSessionInstances.grossCredits })
    .from(browserSessionInstances)
    .where(
      and(
        eq(browserSessionInstances.browserSessionId, browser.id),
        ne(
          browserSessionInstances.providerSessionId,
          instance.providerSessionId,
        ),
      ),
    );
  signal.throwIfAborted();
  const priorGrossCredits = priorInstances.reduce((total, row) => {
    return total + row.grossCredits;
  }, 0);
  return Math.min(
    providerGrossCredits,
    Math.max(browser.maxCredits - priorGrossCredits, 0),
  );
}

function usageEventMatchesBrowserCharge(
  event: typeof usageEvent.$inferSelect,
  browser: BrowserSessionRow,
  instance: BrowserInstanceRow,
  providerCostMicrousd: number,
  grossCredits: number,
): boolean {
  return (
    event.runId === instance.runId &&
    event.orgId === browser.orgId &&
    event.userId === browser.userId &&
    event.kind === BROWSER_USAGE_KIND &&
    event.provider === BROWSER_USAGE_PROVIDER &&
    event.category === BROWSER_USAGE_CATEGORY &&
    event.quantity === providerCostMicrousd &&
    event.grossCredits === grossCredits
  );
}

interface BrowserCharge {
  readonly eventId: string | null;
  readonly creditsCharged: number;
}

const chargeBrowserUsage$ = command(
  async (
    { set },
    args: {
      readonly browser: BrowserSessionRow;
      readonly instance: BrowserInstanceRow;
      readonly providerCostMicrousd: number;
      readonly grossCredits: number;
    },
    signal: AbortSignal,
  ): Promise<BrowserCharge> => {
    if (args.providerCostMicrousd === 0) {
      return { eventId: null, creditsCharged: 0 };
    }
    const db = set(writeDb$);
    await db
      .insert(usageEvent)
      .values({
        runId: args.instance.runId,
        idempotencyKey: args.instance.providerSessionId,
        orgId: args.browser.orgId,
        userId: args.browser.userId,
        kind: BROWSER_USAGE_KIND,
        provider: BROWSER_USAGE_PROVIDER,
        category: BROWSER_USAGE_CATEGORY,
        quantity: args.providerCostMicrousd,
        grossCredits: args.grossCredits,
      })
      .onConflictDoNothing({ target: usageEvent.idempotencyKey });
    signal.throwIfAborted();

    const [event] = await db
      .select()
      .from(usageEvent)
      .where(eq(usageEvent.idempotencyKey, args.instance.providerSessionId))
      .limit(1);
    signal.throwIfAborted();
    if (
      !event ||
      !usageEventMatchesBrowserCharge(
        event,
        args.browser,
        args.instance,
        args.providerCostMicrousd,
        args.grossCredits,
      )
    ) {
      throw new Error("Browser usage idempotency payload mismatch");
    }

    await set(processOrgUsageEvents$, args.browser.orgId, signal);
    const [processed] = await db
      .select({
        id: usageEvent.id,
        creditsCharged: usageEvent.creditsCharged,
        billingError: usageEvent.billingError,
      })
      .from(usageEvent)
      .where(eq(usageEvent.id, event.id))
      .limit(1);
    signal.throwIfAborted();
    if (
      !processed ||
      processed.creditsCharged === null ||
      processed.billingError !== null
    ) {
      throw new Error("Failed to settle managed browser usage");
    }
    return {
      eventId: processed.id,
      creditsCharged: processed.creditsCharged,
    };
  },
);

async function updateBrowserSettlementTotals(
  db: Db,
  browserId: string,
  signal: AbortSignal,
): Promise<void> {
  const instances = await db
    .select({
      grossCredits: browserSessionInstances.grossCredits,
      creditsCharged: browserSessionInstances.creditsCharged,
    })
    .from(browserSessionInstances)
    .where(eq(browserSessionInstances.browserSessionId, browserId));
  signal.throwIfAborted();
  const totals = instances.reduce<{
    grossCredits: number;
    creditsCharged: number;
  }>(
    (current, instance) => {
      return {
        grossCredits: current.grossCredits + instance.grossCredits,
        creditsCharged: current.creditsCharged + (instance.creditsCharged ?? 0),
      };
    },
    { grossCredits: 0, creditsCharged: 0 },
  );
  await db
    .update(browserSessions)
    .set({ ...totals, updatedAt: nowDate() })
    .where(eq(browserSessions.id, browserId));
  signal.throwIfAborted();
}

async function refreshBrowserRow(
  db: Db,
  browserId: string,
): Promise<BrowserSessionRow> {
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(eq(browserSessions.id, browserId))
    .limit(1);
  if (!row) {
    throw new Error("Managed browser disappeared during mutation");
  }
  return row;
}

async function refreshInstanceRow(
  db: Db,
  providerSessionId: string,
): Promise<BrowserInstanceRow> {
  const [row] = await db
    .select()
    .from(browserSessionInstances)
    .where(eq(browserSessionInstances.providerSessionId, providerSessionId))
    .limit(1);
  if (!row) {
    throw new Error("Managed browser provider instance disappeared");
  }
  return row;
}

async function persistStoppedProviderInstance(
  db: Db,
  instance: BrowserInstanceRow,
  provider: BrowserUseSession,
  signal: AbortSignal,
): Promise<BrowserInstanceRow> {
  if (
    provider.id !== instance.providerSessionId ||
    provider.status !== "stopped"
  ) {
    throw new Error(
      "Managed browser provider did not return a stopped session",
    );
  }
  await db
    .update(browserSessionInstances)
    .set({
      status: "stopped",
      browserCostMicrousd: providerUsdToMicrousd([provider.browserCost]),
      proxyCostMicrousd: providerUsdToMicrousd([provider.proxyCost]),
      proxyUsedMb: provider.proxyUsedMb,
      finishedAt: provider.finishedAt
        ? new Date(provider.finishedAt)
        : nowDate(),
      updatedAt: nowDate(),
    })
    .where(
      eq(browserSessionInstances.providerSessionId, instance.providerSessionId),
    );
  signal.throwIfAborted();
  return await refreshInstanceRow(db, instance.providerSessionId);
}

const settleStoppedBrowserInstance$ = command(
  async (
    { set },
    args: {
      readonly browserId: string;
      readonly providerSessionId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const browser = await refreshBrowserRow(db, args.browserId);
    signal.throwIfAborted();
    const instance = await refreshInstanceRow(db, args.providerSessionId);
    signal.throwIfAborted();
    if (instance.settledAt) {
      return false;
    }
    if (instance.status !== "stopped") {
      throw new Error("Cannot settle a browser provider instance before stop");
    }

    const providerCostMicrousd =
      instance.browserCostMicrousd + instance.proxyCostMicrousd;
    const providerGrossCredits = grossCreditsForCost(
      {
        unitPrice: instance.pricingUnitPrice,
        unitSize: instance.pricingUnitSize,
      },
      providerCostMicrousd,
    );
    if (providerGrossCredits === null) {
      throw new Error("Managed browser pricing snapshot is invalid");
    }
    const grossCredits = await cappedInstanceGrossCredits(
      db,
      browser,
      instance,
      providerGrossCredits,
      signal,
    );
    const charge = await set(
      chargeBrowserUsage$,
      {
        browser,
        instance,
        providerCostMicrousd,
        grossCredits,
      },
      signal,
    );

    await db
      .update(browserSessionInstances)
      .set({
        grossCredits,
        creditsCharged: charge.creditsCharged,
        usageEventId: charge.eventId,
        settledAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(
            browserSessionInstances.providerSessionId,
            instance.providerSessionId,
          ),
          isNull(browserSessionInstances.settledAt),
        ),
      );
    signal.throwIfAborted();
    await updateBrowserSettlementTotals(db, browser.id, signal);
    return true;
  },
);

async function markBrowserResumableIfSettled(
  db: Db,
  browserId: string,
  signal: AbortSignal,
): Promise<void> {
  const [pending] = await db
    .select({ count: count() })
    .from(browserSessionInstances)
    .where(
      and(
        eq(browserSessionInstances.browserSessionId, browserId),
        isNull(browserSessionInstances.settledAt),
      ),
    );
  signal.throwIfAborted();
  if ((pending?.count ?? 0) !== 0) {
    return;
  }
  await db
    .update(browserSessions)
    .set({
      status: "suspended",
      suspendedAt: nowDate(),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(browserSessions.id, browserId),
        eq(browserSessions.status, "stopping"),
      ),
    );
  signal.throwIfAborted();
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
  owner: Pick<BrowserRunContext, "orgId" | "userId">,
): Promise<void> {
  const lockKey = `zero_browser_profile:${owner.orgId}:${owner.userId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
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
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
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
  return {
    kind: "ok",
    value: {
      orgId: actor.orgId,
      userId: actor.userId,
      runId: actor.runId,
      chatThreadId: run.chatThreadId,
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

async function loadOwnedBrowserProfile(
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
): Promise<BrowserProfileRow> {
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
  if (!row) {
    throw new Error("Managed browser profile ownership is invalid");
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
    readonly id: string;
    readonly orgId: string;
    readonly userId: string;
    readonly providerProfileId: string;
  },
): Promise<{
  readonly profile: BrowserProfileRow;
  readonly created: boolean;
}> {
  const [created] = await db
    .insert(browserProfiles)
    .values(args)
    .onConflictDoNothing({
      target: [browserProfiles.orgId, browserProfiles.userId],
    })
    .returning();
  if (created) {
    return { profile: created, created: true };
  }
  const existing = await loadOwnedBrowserProfile(db, args);
  if (!existing) {
    throw new Error("Managed browser profile claim did not resolve an owner");
  }
  return { profile: existing, created: false };
}

async function getOrCreateBrowserProfile(
  db: Db,
  context: BrowserRunContext,
): Promise<BrowserServiceResult<BrowserProfileRow>> {
  const existing = await loadOwnedBrowserProfile(db, context);
  if (existing) {
    return { kind: "ok", value: existing };
  }

  let createdProviderProfileId: string | null = null;
  let retainedCreatedProfile = false;
  const transaction = await settle(
    db.transaction(async (tx) => {
      await lockBrowserProfileCreation(tx, context);
      const lockedExisting = await loadOwnedBrowserProfile(tx, context);
      if (lockedExisting) {
        return { kind: "ok" as const, value: lockedExisting };
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

async function claimStartedProviderInstance(
  db: Db,
  args: {
    readonly browser: BrowserSessionRow;
    readonly context: BrowserRunContext;
    readonly provider: BrowserUseSession;
    readonly pricing: BrowserPricing;
  },
) {
  return await db.transaction(async (tx) => {
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
        status: cleanupAfterStart ? "stopping" : "active",
        pricingUnitPrice: args.pricing.unitPrice,
        pricingUnitSize: args.pricing.unitSize,
        timeoutAt: new Date(args.provider.timeoutAt),
        startedAt: new Date(args.provider.startedAt),
        stopRequestedAt: cleanupAfterStart ? nowDate() : null,
      })
      .returning();
    if (!instance) {
      throw new Error("Failed to persist managed browser provider instance");
    }
    if (cleanupAfterStart) {
      return {
        kind: "cleanup" as const,
        browser: current,
        instance,
      };
    }
    await tx
      .update(browserSessions)
      .set({
        status: "active",
        suspendedAt: null,
        suspensionReason: null,
        updatedAt: nowDate(),
      })
      .where(eq(browserSessions.id, current.id));
    return { kind: "active" as const };
  });
}

async function createAndClaimProviderInstance(
  db: Db,
  args: {
    readonly browser: BrowserSessionRow;
    readonly profile: BrowserProfileRow;
    readonly context: BrowserRunContext;
    readonly pricing: BrowserPricing;
  },
) {
  const provider = await providerCall(
    createBrowserUseSession(
      {
        profileId: args.profile.providerProfileId,
        proxyCountryCode: args.browser.proxyCountryCode,
        timeoutMinutes: args.browser.timeoutMinutes,
      },
      AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
    ),
  );
  if (provider.kind === "error") {
    return provider;
  }
  const { cdpUrl, liveUrl } = provider.value;
  if (provider.value.status !== "active" || !cdpUrl || !liveUrl) {
    await settle(
      stopBrowserUseSession(
        provider.value.id,
        AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
      ),
    );
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
    pricing: args.pricing,
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
    const [pricing, profile] = await Promise.all([
      loadBrowserPricing(db),
      loadBrowserProfileForBrowser(db, args.browser),
    ]);
    signal.throwIfAborted();
    if (!pricing) {
      return serviceError(
        503,
        "BROWSER_PRICING_NOT_CONFIGURED",
        "Managed browser pricing is not configured",
      );
    }

    const started = await createAndClaimProviderInstance(db, {
      browser: args.browser,
      profile,
      context: args.context,
      pricing,
    });
    signal.throwIfAborted();
    if (started.kind === "error") {
      return started;
    }
    const { claimed } = started;

    if (claimed.kind === "cleanup") {
      const cleanupSignal = AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS);
      await set(
        finalizeClaimedBrowserInstance$,
        {
          browser: {
            ...claimed.browser,
            status: "stopping",
          },
          instance: claimed.instance,
          reason: claimed.browser.suspensionReason ?? "run_end",
        },
        cleanupSignal,
      );
      signal.throwIfAborted();
      return conflict(
        "The chat run ended while the managed browser was starting",
        "BROWSER_RUN_ENDED",
      );
    }

    if (claimed.kind === "rejected") {
      await settle(
        stopBrowserUseSession(
          started.provider.id,
          AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
        ),
      );
      signal.throwIfAborted();
      return conflict(
        "The chat run ended while the managed browser was starting",
        "BROWSER_RUN_ENDED",
      );
    }

    const browser = await refreshBrowserRow(db, args.browser.id);
    signal.throwIfAborted();
    return {
      kind: "ok",
      value: {
        browser: publicBrowser(browser, started.liveUrl),
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
  },
): Promise<BrowserServiceResult<BrowserSessionRow>> {
  return await db.transaction(async (tx) => {
    await lockBrowserThread(tx, context.chatThreadId);
    const [owned, activeCount, run] = await Promise.all([
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
        .select({ count: count() })
        .from(browserSessions)
        .where(
          and(
            eq(browserSessions.orgId, context.orgId),
            inArray(browserSessions.status, [...OWNED_BROWSER_STATUSES]),
          ),
        ),
      tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, context.runId))
        .limit(1),
    ]);
    if (!run[0] || isTerminalRunStatus(run[0].status)) {
      return conflict("The chat run already ended", "BROWSER_RUN_ENDED");
    }
    if (owned[0]) {
      return conflict(
        "This chat thread already has an active managed browser",
        "BROWSER_THREAD_ACTIVE",
      );
    }
    if ((activeCount[0]?.count ?? 0) >= MAX_ACTIVE_BROWSER_SESSIONS_PER_ORG) {
      return conflict(
        `This organization already has ${MAX_ACTIVE_BROWSER_SESSIONS_PER_ORG} active managed browsers`,
        "BROWSER_CONCURRENCY_LIMIT",
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
        status: "creating",
        proxyCountryCode: args.proxyCountryCode,
        timeoutMinutes: args.timeoutMinutes,
        maxCredits: args.maxCredits,
      })
      .returning();
    if (!browser) {
      throw new Error("Failed to create managed browser");
    }
    return { kind: "ok", value: browser };
  });
}

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
    const creditError = await set(
      checkCreditAmount$,
      {
        orgId: args.actor.orgId,
        requiredCredits: args.input.maxCredits,
      },
      signal,
    );
    if (creditError) {
      return serviceError(
        creditError.status,
        creditError.body.error.code,
        creditError.body.error.message,
      );
    }

    const profile = await getOrCreateBrowserProfile(db, context.value);
    signal.throwIfAborted();
    if (profile.kind === "error") {
      return profile;
    }
    const claimed = await claimFreshBrowser(db, context.value, {
      ...args.input,
      browserId: randomUUID(),
      browserProfileId: profile.value.id,
    });
    signal.throwIfAborted();
    if (claimed.kind === "error") {
      return claimed;
    }

    const connection = await set(
      startProviderInstance$,
      {
        browser: claimed.value,
        context: context.value,
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

interface InspectActiveConnectionResume {
  readonly kind: "resume";
  readonly browser: BrowserSessionRow;
}

const inspectActiveConnection$ = command(
  async (
    { set },
    browser: BrowserSessionRow,
    signal: AbortSignal,
  ): Promise<
    BrowserServiceResult<BrowserConnection> | InspectActiveConnectionResume
  > => {
    const db = set(writeDb$);
    const instance = await loadActiveInstance(db, browser.id);
    signal.throwIfAborted();
    if (!instance) {
      await db
        .update(browserSessions)
        .set({
          status: "suspended",
          suspendedAt: nowDate(),
          suspensionReason: "provider",
          updatedAt: nowDate(),
        })
        .where(eq(browserSessions.id, browser.id));
      signal.throwIfAborted();
      return {
        kind: "resume",
        browser: await refreshBrowserRow(db, browser.id),
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
      return {
        kind: "ok",
        value: {
          browser: publicBrowser(browser, liveUrl),
          cdpUrl,
        },
      };
    }
    const stopped = await persistStoppedProviderInstance(
      db,
      instance,
      provider.value,
      signal,
    );
    await db
      .update(browserSessions)
      .set({
        status: "stopping",
        suspensionReason: "provider",
        updatedAt: nowDate(),
      })
      .where(eq(browserSessions.id, browser.id));
    signal.throwIfAborted();
    await set(
      settleStoppedBrowserInstance$,
      {
        browserId: browser.id,
        providerSessionId: stopped.providerSessionId,
      },
      signal,
    );
    await markBrowserResumableIfSettled(db, browser.id, signal);
    return {
      kind: "resume",
      browser: await refreshBrowserRow(db, browser.id),
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
  expectedBrowserId: string,
  browserProfileId: string,
): Promise<ResumeClaim> {
  return await db.transaction(async (tx) => {
    await lockBrowserThread(tx, context.chatThreadId);
    const [run] = await tx
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, context.runId))
      .limit(1);
    if (!run || isTerminalRunStatus(run.status)) {
      return conflict("The chat run already ended", "BROWSER_RUN_ENDED");
    }
    const owned = await loadOwnedThreadBrowser(tx, context.chatThreadId);
    if (owned) {
      if (owned.status === "active" && owned.runId === context.runId) {
        return { kind: "active", browser: owned };
      }
      if (
        ["creating", "resuming"].includes(owned.status) &&
        owned.runId === context.runId
      ) {
        return conflict(
          "The managed browser is already starting",
          "BROWSER_STARTING",
        );
      }
      return conflict(
        "The previous run is still cleaning up its managed browser",
        "BROWSER_PREVIOUS_RUN_CLEANUP",
      );
    }

    const current = await loadCurrentBrowser(tx, context);
    if (
      !current ||
      current.id !== expectedBrowserId ||
      current.browserProfileId !== browserProfileId
    ) {
      return { kind: "missing" };
    }
    if (current.grossCredits >= current.maxCredits) {
      return conflict(
        "The managed browser reached its credit budget; create a new browser",
        "BROWSER_BUDGET_REACHED",
      );
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

export const resumeZeroBrowser$ = command(
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

    let current = await loadCurrentBrowser(db, context.value);
    signal.throwIfAborted();
    if (!current) {
      return await set(
        createZeroBrowser$,
        {
          actor,
          input: {
            name: "browser",
            proxyCountryCode: null,
            timeoutMinutes: ZERO_BROWSER_DEFAULT_TIMEOUT_MINUTES,
            maxCredits: ZERO_BROWSER_DEFAULT_MAX_CREDITS,
          },
        },
        signal,
      );
    }

    const owned = await loadOwnedThreadBrowser(db, context.value.chatThreadId);
    signal.throwIfAborted();
    if (owned?.status === "active" && owned.runId === context.value.runId) {
      const inspected = await set(inspectActiveConnection$, owned, signal);
      if (inspected.kind !== "resume") {
        return inspected;
      }
      current = inspected.browser;
    } else if (owned) {
      return conflict(
        "The previous run is still cleaning up its managed browser",
        "BROWSER_PREVIOUS_RUN_CLEANUP",
      );
    }

    const remainingCredits = current.maxCredits - current.grossCredits;
    if (remainingCredits <= 0) {
      return conflict(
        "The managed browser reached its credit budget; create a new browser",
        "BROWSER_BUDGET_REACHED",
      );
    }
    const creditError = await set(
      checkCreditAmount$,
      { orgId: actor.orgId, requiredCredits: remainingCredits },
      signal,
    );
    if (creditError) {
      return serviceError(
        creditError.status,
        creditError.body.error.code,
        creditError.body.error.message,
      );
    }

    const claim = await claimBrowserForResume(
      db,
      context.value,
      current.id,
      current.browserProfileId,
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
        claim.browser,
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
      { browser: claim.browser, context: context.value },
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
    let liveUrl: string | null = null;
    if (row.status === "active") {
      const instance = await loadActiveInstance(db, row.id);
      signal.throwIfAborted();
      if (instance) {
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
    return { kind: "ok", value: publicBrowser(row, liveUrl) };
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

async function claimThreadBrowserInstances(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly runId: string;
  },
  signal: AbortSignal,
): Promise<readonly ClaimedBrowserInstance[]> {
  const claimed = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, args.chatThreadId);
    const rows = await tx
      .select({
        browser: browserSessions,
        instance: browserSessionInstances,
        runStatus: agentRuns.status,
      })
      .from(browserSessionInstances)
      .innerJoin(
        browserSessions,
        eq(browserSessions.id, browserSessionInstances.browserSessionId),
      )
      .leftJoin(agentRuns, eq(agentRuns.id, browserSessionInstances.runId))
      .where(
        and(
          eq(browserSessionInstances.chatThreadId, args.chatThreadId),
          inArray(browserSessionInstances.status, [
            ...CLEANUP_INSTANCE_STATUSES,
          ]),
          isNull(browserSessionInstances.settledAt),
        ),
      );
    const candidates = rows.filter((row) => {
      return (
        row.instance.runId === args.runId ||
        row.runStatus === null ||
        isTerminalRunStatus(row.runStatus)
      );
    });

    for (const row of candidates) {
      const reason =
        row.instance.runId === args.runId ? "run_end" : "reconcile";
      await tx
        .update(browserSessions)
        .set({
          status: "stopping",
          suspensionReason: reason,
          updatedAt: nowDate(),
        })
        .where(eq(browserSessions.id, row.browser.id));
      if (row.instance.status === "active") {
        await tx
          .update(browserSessionInstances)
          .set({
            status: "stopping",
            stopRequestedAt: nowDate(),
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(
                browserSessionInstances.providerSessionId,
                row.instance.providerSessionId,
              ),
              eq(browserSessionInstances.status, "active"),
            ),
          );
      }
    }

    await tx
      .update(browserSessions)
      .set({
        status: "stopping",
        suspensionReason: "run_end",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, args.chatThreadId),
          eq(browserSessions.runId, args.runId),
          inArray(browserSessions.status, ["creating", "resuming"]),
        ),
      );

    return candidates.map((row) => {
      const reason: ZeroBrowserSuspensionReason =
        row.instance.runId === args.runId ? "run_end" : "reconcile";
      return {
        browser: {
          ...row.browser,
          status: "stopping" as const,
          suspensionReason: reason,
        },
        instance:
          row.instance.status === "active"
            ? {
                ...row.instance,
                status: "stopping" as const,
                stopRequestedAt: nowDate(),
              }
            : row.instance,
        reason,
      };
    });
  });
  signal.throwIfAborted();
  return claimed;
}

const finalizeClaimedBrowserInstance$ = command(
  async (
    { set },
    claimed: ClaimedBrowserInstance,
    signal: AbortSignal,
  ): Promise<{ readonly stopped: boolean; readonly settled: boolean }> => {
    const db = set(writeDb$);
    let instance = await refreshInstanceRow(
      db,
      claimed.instance.providerSessionId,
    );
    signal.throwIfAborted();
    let stopped = false;
    if (instance.status !== "stopped") {
      const observed = await providerCall(
        getBrowserUseSession(instance.providerSessionId, signal),
      );
      signal.throwIfAborted();
      if (observed.kind === "error") {
        throw new Error(observed.message);
      }
      const provider =
        observed.value.status === "stopped"
          ? observed
          : await providerCall(
              stopBrowserUseSession(instance.providerSessionId, signal),
            );
      signal.throwIfAborted();
      if (provider.kind === "error") {
        throw new Error(provider.message);
      }
      instance = await persistStoppedProviderInstance(
        db,
        instance,
        provider.value,
        signal,
      );
      stopped = true;
    }
    const settledNow = await set(
      settleStoppedBrowserInstance$,
      {
        browserId: claimed.browser.id,
        providerSessionId: instance.providerSessionId,
      },
      signal,
    );
    await markBrowserResumableIfSettled(db, claimed.browser.id, signal);
    return { stopped, settled: settledNow };
  },
);

export const finalizeThreadBrowsersForRun$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly runId: string;
    },
    signal: AbortSignal,
  ): Promise<BrowserFinalizeResult> => {
    const db = set(writeDb$);
    const claimed = await claimThreadBrowserInstances(db, args, signal);
    let stopped = 0;
    let settledCount = 0;
    let errors = 0;
    for (const candidate of claimed) {
      const result = await settle(
        set(finalizeClaimedBrowserInstance$, candidate, signal),
        signal,
      );
      if (!result.ok) {
        errors += 1;
        continue;
      }
      stopped += result.value.stopped ? 1 : 0;
      settledCount += result.value.settled ? 1 : 0;
    }
    return {
      checked: claimed.length,
      stopped,
      settled: settledCount,
      errors,
    };
  },
);

async function claimInstanceForReconcile(
  db: Db,
  row: {
    readonly browser: BrowserSessionRow;
    readonly instance: BrowserInstanceRow;
  },
  reason: ZeroBrowserSuspensionReason,
  signal: AbortSignal,
): Promise<ClaimedBrowserInstance> {
  const claimed = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, row.browser.chatThreadId);
    await tx
      .update(browserSessions)
      .set({
        status: "stopping",
        suspensionReason: reason,
        updatedAt: nowDate(),
      })
      .where(eq(browserSessions.id, row.browser.id));
    if (row.instance.status === "active") {
      await tx
        .update(browserSessionInstances)
        .set({
          status: "stopping",
          stopRequestedAt: nowDate(),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(
              browserSessionInstances.providerSessionId,
              row.instance.providerSessionId,
            ),
            eq(browserSessionInstances.status, "active"),
          ),
        );
    }
    return {
      browser: {
        ...row.browser,
        status: "stopping" as const,
        suspensionReason: reason,
      },
      instance:
        row.instance.status === "active"
          ? {
              ...row.instance,
              status: "stopping" as const,
              stopRequestedAt: nowDate(),
            }
          : row.instance,
      reason,
    };
  });
  signal.throwIfAborted();
  return claimed;
}

async function releaseStrandedBrowserStarts(
  db: Db,
  limit: number,
  signal: AbortSignal,
): Promise<number> {
  const stranded = await db
    .select({ id: browserSessions.id })
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
    await markBrowserResumableIfSettled(db, browser.id, signal);
  }
  return stranded.length;
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
  readonly runStatus: (typeof agentRuns.$inferSelect)["status"] | null;
}

interface BrowserReconcileOutcome {
  readonly stopped: number;
  readonly settled: number;
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
    let instance = row.instance;
    let reason: ZeroBrowserSuspensionReason | null = null;
    if (
      row.instance.status === "stopping" ||
      row.instance.status === "stopped"
    ) {
      reason = row.browser.suspensionReason ?? "reconcile";
    } else if (row.runStatus === null || isTerminalRunStatus(row.runStatus)) {
      reason = "reconcile";
    } else if (row.instance.timeoutAt <= nowDate()) {
      reason = "timeout";
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
        return { stopped: 0, settled: 0, errors: 1, healthy: 0 };
      }
      if (provider.value.status === "stopped") {
        const persisted = await settle(
          persistStoppedProviderInstance(
            db,
            row.instance,
            provider.value,
            signal,
          ),
          signal,
        );
        if (!persisted.ok) {
          return { stopped: 0, settled: 0, errors: 1, healthy: 0 };
        }
        instance = persisted.value;
        reason = "provider";
      } else {
        const currentCost = providerUsdToMicrousd([
          provider.value.browserCost,
          provider.value.proxyCost,
        ]);
        const currentGross = grossCreditsForCost(
          {
            unitPrice: row.instance.pricingUnitPrice,
            unitSize: row.instance.pricingUnitSize,
          },
          currentCost,
        );
        if (
          currentGross !== null &&
          row.browser.grossCredits + currentGross >= row.browser.maxCredits
        ) {
          reason = "budget";
        }
      }
    }
    if (!reason) {
      await deferBrowserInstanceReconcile(
        db,
        row.instance.providerSessionId,
        signal,
      );
      return { stopped: 0, settled: 0, errors: 0, healthy: 1 };
    }

    const claimed = await claimInstanceForReconcile(
      db,
      { browser: row.browser, instance },
      reason,
      signal,
    );
    const finalized = await settle(
      set(finalizeClaimedBrowserInstance$, claimed, signal),
      signal,
    );
    if (!finalized.ok) {
      return { stopped: 0, settled: 0, errors: 1, healthy: 0 };
    }
    return {
      stopped: finalized.value.stopped ? 1 : 0,
      settled: finalized.value.settled ? 1 : 0,
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
        runStatus: agentRuns.status,
      })
      .from(browserSessionInstances)
      .innerJoin(
        browserSessions,
        eq(browserSessions.id, browserSessionInstances.browserSessionId),
      )
      .leftJoin(agentRuns, eq(agentRuns.id, browserSessionInstances.runId))
      .where(
        and(
          inArray(browserSessionInstances.status, [
            ...CLEANUP_INSTANCE_STATUSES,
          ]),
          isNull(browserSessionInstances.settledAt),
        ),
      )
      .orderBy(browserSessionInstances.updatedAt)
      .limit(RECONCILE_BATCH_SIZE);
    signal.throwIfAborted();

    let stopped = 0;
    let settledCount = 0;
    let errors = 0;
    let healthy = 0;
    for (const row of rows) {
      const outcome = await set(reconcileBrowserInstance$, row, signal);
      stopped += outcome.stopped;
      settledCount += outcome.settled;
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
      settled: settledCount,
      errors,
      healthy,
    };
  },
);
