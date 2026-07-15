import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
  usageAllowanceAllocations,
} from "@vm0/db/schema/org-usage-allowance";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { logger } from "../../lib/log";
import { nowDate } from "../external/time";
import type { Db } from "../external/db";
import { getStripeClient } from "../external/stripe-client";

type UsageAllowanceStore = Pick<Db, "execute" | "insert" | "select" | "update">;

type UsageAllowanceWindowKind = "short" | "weekly";

const L = logger("UsageAllowance");
const ACTIVE_ALLOWANCE_STATUSES = [
  "active",
  "manual_active",
  "trialing",
  "past_due",
  "unpaid",
] as const;
const TERMINAL_ALLOWANCE_STATUSES = ["canceled", "incomplete_expired"] as const;
const PAYMENT_FAILED_ALLOWANCE_STATUSES = ["past_due", "unpaid"] as const;
const PAYMENT_FAILURE_ALLOWANCE_GRACE_MS = 24 * 60 * 60 * 1000;

interface UsageAllowanceSubscriptionInput {
  readonly id: string;
  readonly status: string;
  readonly cancel_at?: number | null;
  readonly items: {
    readonly data: readonly {
      readonly current_period_end?: number | null;
    }[];
  };
}

interface UsageAllowanceEntitlement {
  readonly id: string;
  readonly orgId: string;
  readonly status: string;
  readonly shortWindowSeconds: number;
  readonly shortWindowUnits: number;
  readonly weeklyWindowSeconds: number;
  readonly weeklyWindowUnits: number;
  readonly effectiveAt: Date;
  readonly expiresAt: Date | null;
  readonly stripeSubscriptionId: string | null;
}

interface UsageAllowanceWindow {
  readonly id: string;
  readonly kind: string;
  readonly unitLimit: number;
  readonly consumedUnits: number;
}

interface UsageAllowanceWindows {
  readonly shortWindow: UsageAllowanceWindow;
  readonly weeklyWindow: UsageAllowanceWindow;
}

interface UsageAllowanceEventInput {
  readonly usageEventId: string;
  readonly runId: string | null;
  readonly grossUnits: number;
}

interface UsageAllowanceCandidate {
  readonly usageEventId: string;
  readonly runId: string;
  readonly grossUnits: number;
}

interface UsageAllowanceWindowState {
  readonly id: string;
  readonly unitLimit: number;
  consumedUnits: number;
  readonly initialConsumedUnits: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
}

interface MutableUsageAllowanceWindows {
  readonly shortWindow: UsageAllowanceWindowState;
  readonly weeklyWindow: UsageAllowanceWindowState;
}

interface NewUsageAllowanceAllocation {
  readonly usageEventId: string;
  readonly runId: string;
  readonly shortWindowId: string;
  readonly weeklyWindowId: string;
  readonly unitsApplied: number;
}

interface UsageAllowanceAvailability {
  readonly remainingUnits: number;
  readonly shortRemainingUnits: number;
  readonly weeklyRemainingUnits: number;
}

function windowDurationSeconds(
  entitlement: UsageAllowanceEntitlement,
  kind: UsageAllowanceWindowKind,
): number {
  return kind === "short"
    ? entitlement.shortWindowSeconds
    : entitlement.weeklyWindowSeconds;
}

function windowUnitLimit(
  entitlement: UsageAllowanceEntitlement,
  kind: UsageAllowanceWindowKind,
): number {
  return kind === "short"
    ? entitlement.shortWindowUnits
    : entitlement.weeklyWindowUnits;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function remainingUnits(
  window: Pick<UsageAllowanceWindow, "unitLimit" | "consumedUnits">,
): number {
  return Math.max(window.unitLimit - window.consumedUnits, 0);
}

function availabilityFromWindows(
  windows: UsageAllowanceWindows,
): UsageAllowanceAvailability {
  const shortRemainingUnits = remainingUnits(windows.shortWindow);
  const weeklyRemainingUnits = remainingUnits(windows.weeklyWindow);
  return {
    shortRemainingUnits,
    weeklyRemainingUnits,
    remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
  };
}

function subscriptionPeriodEnd(
  subscription: UsageAllowanceSubscriptionInput,
): Date | null {
  const periodEndUnix = subscription.items.data[0]?.current_period_end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

function subscriptionCancelAt(
  subscription: UsageAllowanceSubscriptionInput,
): Date | null {
  return typeof subscription.cancel_at === "number"
    ? new Date(subscription.cancel_at * 1000)
    : null;
}

function subscriptionScheduledEnd(
  subscription: UsageAllowanceSubscriptionInput,
): Date | null {
  const periodEnd = subscriptionPeriodEnd(subscription);
  const cancelAt = subscriptionCancelAt(subscription);
  if (!periodEnd) {
    return null;
  }
  return cancelAt && cancelAt < periodEnd ? cancelAt : periodEnd;
}

function subscriptionCanBackUsageAllowance(
  subscription: UsageAllowanceSubscriptionInput,
): boolean {
  return ACTIVE_ALLOWANCE_STATUSES.includes(
    subscription.status as (typeof ACTIVE_ALLOWANCE_STATUSES)[number],
  );
}

function subscriptionIsTerminalAllowance(
  subscription: UsageAllowanceSubscriptionInput,
): boolean {
  return TERMINAL_ALLOWANCE_STATUSES.includes(
    subscription.status as (typeof TERMINAL_ALLOWANCE_STATUSES)[number],
  );
}

function allowanceIsPaymentFailed(status: string): boolean {
  return PAYMENT_FAILED_ALLOWANCE_STATUSES.includes(
    status as (typeof PAYMENT_FAILED_ALLOWANCE_STATUSES)[number],
  );
}

function activeAllowanceCutoff(status: string, now: Date): Date {
  return allowanceIsPaymentFailed(status)
    ? new Date(now.getTime() - PAYMENT_FAILURE_ALLOWANCE_GRACE_MS)
    : now;
}

async function refreshUsageAllowanceEntitlementFromStripe(
  tx: UsageAllowanceStore,
  entitlement: UsageAllowanceEntitlement,
  now: Date,
): Promise<UsageAllowanceEntitlement | null> {
  if (!entitlement.stripeSubscriptionId) {
    return null;
  }

  L.warn(
    "usage allowance entitlement expired locally, refreshing from Stripe",
    {
      orgId: entitlement.orgId,
      entitlementId: entitlement.id,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      expiresAt: entitlement.expiresAt,
    },
  );

  const subscription = (await getStripeClient().subscriptions.retrieve(
    entitlement.stripeSubscriptionId,
  )) as UsageAllowanceSubscriptionInput;
  const periodEnd = subscriptionScheduledEnd(subscription);

  if (subscriptionIsTerminalAllowance(subscription)) {
    await tx
      .update(orgUsageAllowanceEntitlements)
      .set({
        status: "canceled",
        expiresAt: now,
        updatedAt: now,
      })
      .where(eq(orgUsageAllowanceEntitlements.id, entitlement.id));
    return null;
  }

  if (!subscriptionCanBackUsageAllowance(subscription)) {
    L.warn("usage allowance subscription has unexpected Stripe status", {
      orgId: entitlement.orgId,
      entitlementId: entitlement.id,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      status: subscription.status,
    });
    return null;
  }

  const cutoff = activeAllowanceCutoff(subscription.status, now);
  if (!periodEnd || periodEnd <= cutoff) {
    L.warn("usage allowance subscription has no future paid-through period", {
      orgId: entitlement.orgId,
      entitlementId: entitlement.id,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      status: subscription.status,
      periodEnd,
    });
    return null;
  }

  await tx
    .update(orgUsageAllowanceEntitlements)
    .set({
      status: subscription.status,
      expiresAt: periodEnd,
      updatedAt: now,
    })
    .where(eq(orgUsageAllowanceEntitlements.id, entitlement.id));

  return {
    ...entitlement,
    status: subscription.status,
    expiresAt: periodEnd,
  };
}

async function lockUsageAllowanceOrg(
  tx: UsageAllowanceStore,
  orgId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('credit_' || ${orgId}))`,
  );
}

async function loadActiveUsageAllowanceEntitlement(
  tx: UsageAllowanceStore,
  orgId: string,
): Promise<UsageAllowanceEntitlement | null> {
  const currentTime = nowDate();
  const [row] = await tx
    .select({
      id: orgUsageAllowanceEntitlements.id,
      orgId: orgUsageAllowanceEntitlements.orgId,
      status: orgUsageAllowanceEntitlements.status,
      shortWindowSeconds: orgUsageAllowanceEntitlements.shortWindowSeconds,
      shortWindowUnits: orgUsageAllowanceEntitlements.shortWindowUnits,
      weeklyWindowSeconds: orgUsageAllowanceEntitlements.weeklyWindowSeconds,
      weeklyWindowUnits: orgUsageAllowanceEntitlements.weeklyWindowUnits,
      effectiveAt: orgUsageAllowanceEntitlements.effectiveAt,
      expiresAt: orgUsageAllowanceEntitlements.expiresAt,
      stripeSubscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
    })
    .from(orgUsageAllowanceEntitlements)
    .where(
      and(
        eq(orgUsageAllowanceEntitlements.orgId, orgId),
        inArray(orgUsageAllowanceEntitlements.status, [
          ...ACTIVE_ALLOWANCE_STATUSES,
        ]),
        lte(orgUsageAllowanceEntitlements.effectiveAt, currentTime),
        or(
          isNull(orgUsageAllowanceEntitlements.expiresAt),
          gt(orgUsageAllowanceEntitlements.expiresAt, currentTime),
          isNotNull(orgUsageAllowanceEntitlements.stripeSubscriptionId),
        ),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const cutoff = activeAllowanceCutoff(row.status, currentTime);
  if (!row.expiresAt || row.expiresAt > cutoff) {
    return row;
  }
  return await refreshUsageAllowanceEntitlementFromStripe(tx, row, currentTime);
}

async function loadVm0RunCreatedAt(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly runId: string;
  },
): Promise<Date | null> {
  const [row] = await tx
    .select({ createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.id, args.runId),
        eq(zeroRuns.modelProvider, "vm0"),
      ),
    )
    .limit(1);
  return row?.createdAt ?? null;
}

async function lockActiveWindowAt(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly kind: UsageAllowanceWindowKind;
    readonly at: Date;
  },
): Promise<UsageAllowanceWindow | null> {
  const currentTime = nowDate();
  const [window] = await tx
    .select({
      id: orgUsageAllowanceWindows.id,
      kind: orgUsageAllowanceWindows.kind,
      unitLimit: orgUsageAllowanceWindows.unitLimit,
      consumedUnits: orgUsageAllowanceWindows.consumedUnits,
    })
    .from(orgUsageAllowanceWindows)
    .innerJoin(
      orgUsageAllowanceEntitlements,
      eq(
        orgUsageAllowanceEntitlements.id,
        orgUsageAllowanceWindows.entitlementId,
      ),
    )
    .where(
      and(
        eq(orgUsageAllowanceWindows.orgId, args.orgId),
        eq(orgUsageAllowanceEntitlements.orgId, args.orgId),
        inArray(orgUsageAllowanceEntitlements.status, [
          ...ACTIVE_ALLOWANCE_STATUSES,
        ]),
        lte(orgUsageAllowanceEntitlements.effectiveAt, currentTime),
        or(
          isNull(orgUsageAllowanceEntitlements.expiresAt),
          gt(orgUsageAllowanceEntitlements.expiresAt, currentTime),
        ),
        gte(
          orgUsageAllowanceWindows.startsAt,
          orgUsageAllowanceEntitlements.effectiveAt,
        ),
        eq(orgUsageAllowanceWindows.kind, args.kind),
        lte(orgUsageAllowanceWindows.startsAt, args.at),
        gt(orgUsageAllowanceWindows.expiresAt, args.at),
      ),
    )
    .orderBy(desc(orgUsageAllowanceWindows.startsAt))
    .limit(1)
    .for("update");
  return window ?? null;
}

async function lockIssuedWindowAt(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly kind: UsageAllowanceWindowKind;
    readonly at: Date;
  },
): Promise<UsageAllowanceWindow | null> {
  const [window] = await tx
    .select({
      id: orgUsageAllowanceWindows.id,
      kind: orgUsageAllowanceWindows.kind,
      unitLimit: orgUsageAllowanceWindows.unitLimit,
      consumedUnits: orgUsageAllowanceWindows.consumedUnits,
    })
    .from(orgUsageAllowanceWindows)
    .where(
      and(
        eq(orgUsageAllowanceWindows.orgId, args.orgId),
        eq(orgUsageAllowanceWindows.kind, args.kind),
        lte(orgUsageAllowanceWindows.startsAt, args.at),
        gt(orgUsageAllowanceWindows.expiresAt, args.at),
      ),
    )
    .orderBy(desc(orgUsageAllowanceWindows.startsAt))
    .limit(1)
    .for("update");
  return window ?? null;
}

async function insertWindow(
  tx: UsageAllowanceStore,
  args: {
    readonly entitlement: UsageAllowanceEntitlement;
    readonly kind: UsageAllowanceWindowKind;
    readonly startsAt: Date;
    readonly createdByRunId: string;
  },
): Promise<UsageAllowanceWindow> {
  const [window] = await tx
    .insert(orgUsageAllowanceWindows)
    .values({
      orgId: args.entitlement.orgId,
      entitlementId: args.entitlement.id,
      kind: args.kind,
      startsAt: args.startsAt,
      expiresAt: addSeconds(
        args.startsAt,
        windowDurationSeconds(args.entitlement, args.kind),
      ),
      unitLimit: windowUnitLimit(args.entitlement, args.kind),
      consumedUnits: 0,
      createdByRunId: args.createdByRunId,
    })
    .returning({
      id: orgUsageAllowanceWindows.id,
      kind: orgUsageAllowanceWindows.kind,
      unitLimit: orgUsageAllowanceWindows.unitLimit,
      consumedUnits: orgUsageAllowanceWindows.consumedUnits,
    });
  if (!window) {
    throw new Error("Usage allowance window insert returned no row");
  }
  return window;
}

async function ensureWindowForRun(
  tx: UsageAllowanceStore,
  args: {
    readonly entitlement: UsageAllowanceEntitlement;
    readonly kind: UsageAllowanceWindowKind;
    readonly runId: string;
    readonly runCreatedAt: Date;
  },
): Promise<UsageAllowanceWindow> {
  const existing = await lockActiveWindowAt(tx, {
    orgId: args.entitlement.orgId,
    kind: args.kind,
    at: args.runCreatedAt,
  });
  if (existing) {
    return existing;
  }

  return await insertWindow(tx, {
    entitlement: args.entitlement,
    kind: args.kind,
    startsAt: args.runCreatedAt,
    createdByRunId: args.runId,
  });
}

async function ensureWindowsForRun(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly runId: string;
    readonly runCreatedAt: Date;
  },
): Promise<UsageAllowanceWindows | null> {
  const entitlement = await loadActiveUsageAllowanceEntitlement(tx, args.orgId);
  if (!entitlement) {
    return null;
  }

  const shortWindow = await ensureWindowForRun(tx, {
    entitlement,
    kind: "short",
    runId: args.runId,
    runCreatedAt: args.runCreatedAt,
  });
  const weeklyWindow = await ensureWindowForRun(tx, {
    entitlement,
    kind: "weekly",
    runId: args.runId,
    runCreatedAt: args.runCreatedAt,
  });
  return { shortWindow, weeklyWindow };
}

async function loadExistingWindowsForRun(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly runId: string;
  },
): Promise<UsageAllowanceWindows | null> {
  const runCreatedAt = await loadVm0RunCreatedAt(tx, args);
  if (!runCreatedAt) {
    return null;
  }

  const shortWindow = await lockIssuedWindowAt(tx, {
    orgId: args.orgId,
    kind: "short",
    at: runCreatedAt,
  });
  const weeklyWindow = await lockIssuedWindowAt(tx, {
    orgId: args.orgId,
    kind: "weekly",
    at: runCreatedAt,
  });

  return shortWindow && weeklyWindow ? { shortWindow, weeklyWindow } : null;
}

async function readWindowAvailability(
  tx: UsageAllowanceStore,
  args: {
    readonly entitlement: UsageAllowanceEntitlement;
    readonly kind: UsageAllowanceWindowKind;
    readonly at: Date;
  },
): Promise<number> {
  const window = await lockActiveWindowAt(tx, {
    orgId: args.entitlement.orgId,
    kind: args.kind,
    at: args.at,
  });
  if (!window) {
    return windowUnitLimit(args.entitlement, args.kind);
  }
  return remainingUnits(window);
}

async function resolveAvailabilityInLockedTransaction(
  tx: UsageAllowanceStore,
  orgId: string,
): Promise<UsageAllowanceAvailability | null> {
  const entitlement = await loadActiveUsageAllowanceEntitlement(tx, orgId);
  if (!entitlement) {
    return null;
  }
  const at = nowDate();
  const shortRemainingUnits = await readWindowAvailability(tx, {
    entitlement,
    kind: "short",
    at,
  });
  const weeklyRemainingUnits = await readWindowAvailability(tx, {
    entitlement,
    kind: "weekly",
    at,
  });
  return {
    shortRemainingUnits,
    weeklyRemainingUnits,
    remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
  };
}

export async function resolveUsageAllowanceAvailability(
  db: Db,
  orgId: string,
): Promise<UsageAllowanceAvailability | null> {
  return await db.transaction(async (tx) => {
    await lockUsageAllowanceOrg(tx, orgId);
    return await resolveAvailabilityInLockedTransaction(tx, orgId);
  });
}

export async function activateUsageAllowanceWindowsForRun(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly runId: string;
    readonly runCreatedAt: Date;
  },
): Promise<UsageAllowanceAvailability | null> {
  await lockUsageAllowanceOrg(tx, args.orgId);
  const windows = await ensureWindowsForRun(tx, args);
  return windows ? availabilityFromWindows(windows) : null;
}

export async function resolveUsageAllowanceAvailabilityForRun(
  db: Db,
  args: {
    readonly orgId: string;
    readonly runId: string;
  },
): Promise<UsageAllowanceAvailability | null> {
  return await db.transaction(async (tx) => {
    await lockUsageAllowanceOrg(tx, args.orgId);
    const windows = await loadExistingWindowsForRun(tx, args);
    return windows ? availabilityFromWindows(windows) : null;
  });
}

async function loadExistingUsageAllowanceAllocations(
  tx: UsageAllowanceStore,
  usageEventIds: readonly string[],
): Promise<Map<string, number>> {
  if (usageEventIds.length === 0) {
    return new Map();
  }

  const rows = await tx
    .select({
      usageEventId: usageAllowanceAllocations.usageEventId,
      unitsApplied: usageAllowanceAllocations.unitsApplied,
    })
    .from(usageAllowanceAllocations)
    .where(
      sql`${usageAllowanceAllocations.usageEventId} = ANY(${sql.param([...usageEventIds])}::uuid[])`,
    );
  return new Map(
    rows.map((row) => {
      return [row.usageEventId, row.unitsApplied];
    }),
  );
}

async function loadVm0RunCreatedAts(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly runIds: readonly string[];
  },
): Promise<Map<string, Date>> {
  if (args.runIds.length === 0) {
    return new Map();
  }

  const rows = await tx
    .select({ id: agentRuns.id, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(agentRuns.orgId, args.orgId),
        eq(zeroRuns.modelProvider, "vm0"),
        sql`${agentRuns.id} = ANY(${sql.param([...args.runIds])}::uuid[])`,
      ),
    );
  return new Map(
    rows.map((row) => {
      return [row.id, row.createdAt];
    }),
  );
}

async function lockIssuedWindowsForRuns(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly kind: UsageAllowanceWindowKind;
    readonly runIds: readonly string[];
  },
): Promise<UsageAllowanceWindowState[]> {
  if (args.runIds.length === 0) {
    return [];
  }

  const windows = await tx
    .select({
      id: orgUsageAllowanceWindows.id,
      unitLimit: orgUsageAllowanceWindows.unitLimit,
      consumedUnits: orgUsageAllowanceWindows.consumedUnits,
      startsAt: orgUsageAllowanceWindows.startsAt,
      expiresAt: orgUsageAllowanceWindows.expiresAt,
    })
    .from(orgUsageAllowanceWindows)
    .where(
      and(
        eq(orgUsageAllowanceWindows.orgId, args.orgId),
        eq(orgUsageAllowanceWindows.kind, args.kind),
        sql`EXISTS (
          SELECT 1
          FROM ${agentRuns}
          INNER JOIN ${zeroRuns} ON ${zeroRuns.id} = ${agentRuns.id}
          WHERE ${agentRuns.orgId} = ${args.orgId}
            AND ${zeroRuns.modelProvider} = 'vm0'
            AND ${agentRuns.id} = ANY(${sql.param([...args.runIds])}::uuid[])
            AND ${orgUsageAllowanceWindows.startsAt} <= ${agentRuns.createdAt}
            AND ${orgUsageAllowanceWindows.expiresAt} > ${agentRuns.createdAt}
        )`,
      ),
    )
    .orderBy(asc(orgUsageAllowanceWindows.id))
    .for("update");

  return windows.map((window) => {
    return {
      ...window,
      initialConsumedUnits: window.consumedUnits,
    };
  });
}

function latestIssuedWindowAt(
  windows: readonly UsageAllowanceWindowState[],
  at: Date,
): UsageAllowanceWindowState | null {
  let latest: UsageAllowanceWindowState | null = null;
  const atMs = at.getTime();
  for (const window of windows) {
    if (
      window.startsAt.getTime() <= atMs &&
      window.expiresAt.getTime() > atMs &&
      (!latest || window.startsAt.getTime() > latest.startsAt.getTime())
    ) {
      latest = window;
    }
  }
  return latest;
}

async function persistUsageAllowanceWindowConsumption(
  tx: UsageAllowanceStore,
  windows: readonly UsageAllowanceWindowState[],
): Promise<void> {
  const changedWindows = windows.filter((window) => {
    return window.consumedUnits > window.initialConsumedUnits;
  });
  if (changedWindows.length === 0) {
    return;
  }

  const windowIds = changedWindows.map((window) => {
    return window.id;
  });
  const unitDeltas = changedWindows.map((window) => {
    return window.consumedUnits - window.initialConsumedUnits;
  });
  await tx.execute(sql`
    UPDATE ${orgUsageAllowanceWindows}
    SET
      "consumed_units" = ${orgUsageAllowanceWindows.consumedUnits} + consumption.units_applied,
      "updated_at" = ${nowDate()}
    FROM unnest(
      ${sql.param(windowIds)}::uuid[],
      ${sql.param(unitDeltas)}::bigint[]
    ) AS consumption(window_id, units_applied)
    WHERE ${orgUsageAllowanceWindows.id} = consumption.window_id
  `);
}

async function insertUsageAllowanceAllocations(
  tx: UsageAllowanceStore,
  orgId: string,
  allocations: readonly NewUsageAllowanceAllocation[],
): Promise<void> {
  if (allocations.length === 0) {
    return;
  }

  const usageEventIds = allocations.map((allocation) => {
    return allocation.usageEventId;
  });
  const runIds = allocations.map((allocation) => {
    return allocation.runId;
  });
  const shortWindowIds = allocations.map((allocation) => {
    return allocation.shortWindowId;
  });
  const weeklyWindowIds = allocations.map((allocation) => {
    return allocation.weeklyWindowId;
  });
  const unitsApplied = allocations.map((allocation) => {
    return allocation.unitsApplied;
  });

  await tx.execute(sql`
    INSERT INTO ${usageAllowanceAllocations} (
      "usage_event_id",
      "org_id",
      "run_id",
      "short_window_id",
      "weekly_window_id",
      "units_applied"
    )
    SELECT
      allocation.usage_event_id,
      ${orgId},
      allocation.run_id,
      allocation.short_window_id,
      allocation.weekly_window_id,
      allocation.units_applied
    FROM unnest(
      ${sql.param(usageEventIds)}::uuid[],
      ${sql.param(runIds)}::uuid[],
      ${sql.param(shortWindowIds)}::uuid[],
      ${sql.param(weeklyWindowIds)}::uuid[],
      ${sql.param(unitsApplied)}::bigint[]
    ) AS allocation(
      usage_event_id,
      run_id,
      short_window_id,
      weekly_window_id,
      units_applied
    )
  `);
}

export async function applyUsageAllowanceToUsageEventsInLockedTransaction(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly events: readonly UsageAllowanceEventInput[];
  },
): Promise<ReadonlyMap<string, number>> {
  const candidates: UsageAllowanceCandidate[] = [];
  for (const event of args.events) {
    if (event.grossUnits > 0 && event.runId) {
      candidates.push({
        usageEventId: event.usageEventId,
        runId: event.runId,
        grossUnits: event.grossUnits,
      });
    }
  }

  const allowanceByUsageEvent = await loadExistingUsageAllowanceAllocations(
    tx,
    candidates.map((candidate) => {
      return candidate.usageEventId;
    }),
  );
  const unresolvedRunIds = [
    ...new Set(
      candidates.flatMap((candidate) => {
        return allowanceByUsageEvent.has(candidate.usageEventId)
          ? []
          : [candidate.runId];
      }),
    ),
  ];
  const runCreatedAtById = await loadVm0RunCreatedAts(tx, {
    orgId: args.orgId,
    runIds: unresolvedRunIds,
  });
  const eligibleRunIds = [...runCreatedAtById.keys()];

  // Preserve the existing short-before-weekly row-lock order.
  const shortWindows = await lockIssuedWindowsForRuns(tx, {
    orgId: args.orgId,
    kind: "short",
    runIds: eligibleRunIds,
  });
  const weeklyWindows = await lockIssuedWindowsForRuns(tx, {
    orgId: args.orgId,
    kind: "weekly",
    runIds: eligibleRunIds,
  });
  const windowsByRunId = new Map<string, MutableUsageAllowanceWindows>();
  for (const [runId, runCreatedAt] of runCreatedAtById) {
    const shortWindow = latestIssuedWindowAt(shortWindows, runCreatedAt);
    const weeklyWindow = latestIssuedWindowAt(weeklyWindows, runCreatedAt);
    if (shortWindow && weeklyWindow) {
      windowsByRunId.set(runId, { shortWindow, weeklyWindow });
    }
  }

  const newAllocations: NewUsageAllowanceAllocation[] = [];
  for (const candidate of candidates) {
    if (allowanceByUsageEvent.has(candidate.usageEventId)) {
      continue;
    }
    const windows = windowsByRunId.get(candidate.runId);
    if (!windows) {
      continue;
    }
    const unitsApplied = Math.min(
      candidate.grossUnits,
      remainingUnits(windows.shortWindow),
      remainingUnits(windows.weeklyWindow),
    );
    if (unitsApplied <= 0) {
      continue;
    }

    windows.shortWindow.consumedUnits += unitsApplied;
    windows.weeklyWindow.consumedUnits += unitsApplied;
    allowanceByUsageEvent.set(candidate.usageEventId, unitsApplied);
    newAllocations.push({
      usageEventId: candidate.usageEventId,
      runId: candidate.runId,
      shortWindowId: windows.shortWindow.id,
      weeklyWindowId: windows.weeklyWindow.id,
      unitsApplied,
    });
  }

  await persistUsageAllowanceWindowConsumption(tx, [
    ...shortWindows,
    ...weeklyWindows,
  ]);
  await insertUsageAllowanceAllocations(tx, args.orgId, newAllocations);

  return allowanceByUsageEvent;
}
