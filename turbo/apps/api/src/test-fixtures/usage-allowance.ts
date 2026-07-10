/**
 * In-process test fixture for `org_usage_allowance_entitlements`.
 *
 * Settlement-focused tests seed entitlements directly so they do not need to
 * repeat the Stripe invoice setup covered by webhook integration tests. This
 * module only upserts the per-org entitlement row. Allowance windows and
 * allocations are deliberately NOT seeded here — production creates those
 * during vm0 run creation and usage-event settlement, and tests must drive
 * them through those paths.
 */
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@vm0/db/schema/org-usage-allowance";
import { createStore } from "ccstate";
import { and, eq, gt, lte, sql } from "drizzle-orm";

import { timestampWithoutTimeZone } from "../lib/time";
import { writeDb$ } from "../signals/external/db";

interface UsageAllowanceEntitlementFixtureState {
  readonly orgId: string;
  readonly status: string;
  readonly shortWindowSeconds: number;
  readonly shortWindowUnits: number;
  readonly weeklyWindowSeconds: number;
  readonly weeklyWindowUnits: number;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeInvoiceId: string | null;
}

interface UsageAllowanceWindowFixtureSeed {
  readonly kind: "short" | "weekly";
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly unitLimit: number;
  readonly consumedUnits?: number;
}

export async function upsertUsageAllowanceEntitlementFixture(values: {
  readonly orgId: string;
  readonly shortWindowSeconds: number;
  readonly shortWindowUnits: number;
  readonly weeklyWindowUnits: number;
  readonly weeklyWindowSeconds?: number;
  readonly status?: string;
}): Promise<void> {
  const status = values.status ?? "active";
  const weeklyWindowSeconds = values.weeklyWindowSeconds ?? 604_800;
  await createStore()
    .set(writeDb$)
    .insert(orgUsageAllowanceEntitlements)
    .values({
      orgId: values.orgId,
      source: "manual",
      status,
      shortWindowSeconds: values.shortWindowSeconds,
      shortWindowUnits: values.shortWindowUnits,
      weeklyWindowSeconds,
      weeklyWindowUnits: values.weeklyWindowUnits,
    })
    .onConflictDoUpdate({
      target: orgUsageAllowanceEntitlements.orgId,
      set: {
        source: "manual",
        status,
        shortWindowSeconds: values.shortWindowSeconds,
        shortWindowUnits: values.shortWindowUnits,
        weeklyWindowSeconds,
        weeklyWindowUnits: values.weeklyWindowUnits,
        updatedAt: sql`now()`,
      },
    });
}

export async function insertUsageAllowanceWindowsFixture(values: {
  readonly orgId: string;
  readonly windows: readonly UsageAllowanceWindowFixtureSeed[];
}): Promise<void> {
  if (values.windows.length === 0) {
    return;
  }

  const db = createStore().set(writeDb$);
  const [entitlement] = await db
    .select({ id: orgUsageAllowanceEntitlements.id })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, values.orgId))
    .limit(1);

  if (!entitlement) {
    throw new Error(
      `insertUsageAllowanceWindowsFixture: missing entitlement for ${values.orgId}`,
    );
  }

  await db.insert(orgUsageAllowanceWindows).values(
    values.windows.map((window) => {
      return {
        orgId: values.orgId,
        entitlementId: entitlement.id,
        kind: window.kind,
        startsAt: window.startsAt,
        expiresAt: window.expiresAt,
        unitLimit: window.unitLimit,
        consumedUnits: window.consumedUnits ?? 0,
      };
    }),
  );
}

export async function cancelUsageAllowanceEntitlementFixture(values: {
  readonly orgId: string;
  readonly canceledAt: Date;
}): Promise<void> {
  const db = createStore().set(writeDb$);
  await db
    .update(orgUsageAllowanceEntitlements)
    .set({
      status: "canceled",
      expiresAt: values.canceledAt,
      updatedAt: values.canceledAt,
    })
    .where(eq(orgUsageAllowanceEntitlements.orgId, values.orgId));

  await db
    .update(orgUsageAllowanceWindows)
    .set({
      expiresAt: sql<Date>`GREATEST(${timestampWithoutTimeZone(values.canceledAt)}::timestamp, ${orgUsageAllowanceWindows.startsAt} + INTERVAL '1 millisecond')`,
      updatedAt: values.canceledAt,
    })
    .where(
      and(
        eq(orgUsageAllowanceWindows.orgId, values.orgId),
        lte(orgUsageAllowanceWindows.startsAt, values.canceledAt),
        gt(orgUsageAllowanceWindows.expiresAt, values.canceledAt),
      ),
    );
}

export async function readUsageAllowanceEntitlementFixture(
  orgId: string,
): Promise<UsageAllowanceEntitlementFixtureState | null> {
  const [row] = await createStore()
    .set(writeDb$)
    .select({
      orgId: orgUsageAllowanceEntitlements.orgId,
      status: orgUsageAllowanceEntitlements.status,
      shortWindowSeconds: orgUsageAllowanceEntitlements.shortWindowSeconds,
      shortWindowUnits: orgUsageAllowanceEntitlements.shortWindowUnits,
      weeklyWindowSeconds: orgUsageAllowanceEntitlements.weeklyWindowSeconds,
      weeklyWindowUnits: orgUsageAllowanceEntitlements.weeklyWindowUnits,
      effectiveAt: orgUsageAllowanceEntitlements.effectiveAt,
      expiresAt: orgUsageAllowanceEntitlements.expiresAt,
      stripeCustomerId: orgUsageAllowanceEntitlements.stripeCustomerId,
      stripeSubscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
      stripeInvoiceId: orgUsageAllowanceEntitlements.stripeInvoiceId,
    })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, orgId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    ...row,
    effectiveAt: row.effectiveAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}
