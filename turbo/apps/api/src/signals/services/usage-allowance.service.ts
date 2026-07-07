import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
  usageAllowanceAllocations,
} from "@vm0/db/schema/org-usage-allowance";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";

import { nowDate } from "../external/time";
import type { Db } from "../external/db";

type UsageAllowanceStore = Pick<Db, "execute" | "insert" | "select" | "update">;

type UsageAllowanceWindowKind = "short" | "weekly";

const ACTIVE_ALLOWANCE_STATUSES = [
  "active",
  "manual_active",
  "trialing",
] as const;

interface UsageAllowanceEntitlement {
  readonly id: string;
  readonly orgId: string;
  readonly shortWindowSeconds: number;
  readonly shortWindowUnits: number;
  readonly weeklyWindowSeconds: number;
  readonly weeklyWindowUnits: number;
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

function remainingUnits(window: UsageAllowanceWindow): number {
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
  const [row] = await tx
    .select({
      id: orgUsageAllowanceEntitlements.id,
      orgId: orgUsageAllowanceEntitlements.orgId,
      shortWindowSeconds: orgUsageAllowanceEntitlements.shortWindowSeconds,
      shortWindowUnits: orgUsageAllowanceEntitlements.shortWindowUnits,
      weeklyWindowSeconds: orgUsageAllowanceEntitlements.weeklyWindowSeconds,
      weeklyWindowUnits: orgUsageAllowanceEntitlements.weeklyWindowUnits,
    })
    .from(orgUsageAllowanceEntitlements)
    .where(
      and(
        eq(orgUsageAllowanceEntitlements.orgId, orgId),
        inArray(orgUsageAllowanceEntitlements.status, [
          ...ACTIVE_ALLOWANCE_STATUSES,
        ]),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadRunCreatedAt(
  tx: UsageAllowanceStore,
  args: {
    readonly orgId: string;
    readonly runId: string;
  },
): Promise<Date | null> {
  const [row] = await tx
    .select({ createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, args.orgId), eq(agentRuns.id, args.runId)))
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
    const runCreatedAt = await loadRunCreatedAt(tx, args);
    if (!runCreatedAt) {
      return null;
    }
    const windows = await ensureWindowsForRun(tx, {
      ...args,
      runCreatedAt,
    });
    return windows ? availabilityFromWindows(windows) : null;
  });
}

export async function applyUsageAllowanceToUsageEvent(
  tx: UsageAllowanceStore,
  args: {
    readonly usageEventId: string;
    readonly orgId: string;
    readonly runId: string | null;
    readonly grossUnits: number;
  },
): Promise<number> {
  if (args.grossUnits <= 0 || !args.runId) {
    return 0;
  }

  await lockUsageAllowanceOrg(tx, args.orgId);

  const [existing] = await tx
    .select({ unitsApplied: usageAllowanceAllocations.unitsApplied })
    .from(usageAllowanceAllocations)
    .where(eq(usageAllowanceAllocations.usageEventId, args.usageEventId))
    .limit(1);
  if (existing) {
    return existing.unitsApplied;
  }

  const runCreatedAt = await loadRunCreatedAt(tx, {
    orgId: args.orgId,
    runId: args.runId,
  });
  if (!runCreatedAt) {
    return 0;
  }

  const windows = await ensureWindowsForRun(tx, {
    orgId: args.orgId,
    runId: args.runId,
    runCreatedAt,
  });
  if (!windows) {
    return 0;
  }

  const unitsApplied = Math.min(
    args.grossUnits,
    remainingUnits(windows.shortWindow),
    remainingUnits(windows.weeklyWindow),
  );
  if (unitsApplied <= 0) {
    return 0;
  }

  await tx
    .update(orgUsageAllowanceWindows)
    .set({
      consumedUnits: sql`${orgUsageAllowanceWindows.consumedUnits} + ${unitsApplied}`,
      updatedAt: nowDate(),
    })
    .where(
      inArray(orgUsageAllowanceWindows.id, [
        windows.shortWindow.id,
        windows.weeklyWindow.id,
      ]),
    );

  await tx.insert(usageAllowanceAllocations).values({
    usageEventId: args.usageEventId,
    orgId: args.orgId,
    runId: args.runId,
    shortWindowId: windows.shortWindow.id,
    weeklyWindowId: windows.weeklyWindow.id,
    unitsApplied,
  });

  return unitsApplied;
}
