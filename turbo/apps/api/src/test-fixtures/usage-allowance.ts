/**
 * In-process test fixture for `org_usage_allowance_entitlements`.
 *
 * Usage-allowance entitlements are operator-managed configuration with no
 * product write path: no API route, webhook, or cron inserts into this table
 * (the billing reconcile cron only manages concurrency entitlements), so
 * tests cannot grant an org a usage allowance through any product endpoint.
 * This module is the narrow test-boundary exception for that state: it only
 * upserts the per-org entitlement row. Allowance windows and allocations are
 * deliberately NOT seeded here — production creates those during vm0 run
 * creation and usage-event settlement, and tests must drive them through
 * those paths.
 */
import { orgUsageAllowanceEntitlements } from "@vm0/db/schema/org-usage-allowance";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

export interface UsageAllowanceEntitlementFixtureState {
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
