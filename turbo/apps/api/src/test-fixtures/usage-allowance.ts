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
import { sql } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

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
