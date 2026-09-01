import { pgTable } from "drizzle-orm/pg-core";

import { orgPlanEntitlementCanonicalColumns } from "../schema/org-plan-entitlement";

/**
 * Canonical-only application write projection for org plan entitlements.
 *
 * Keeping active inserts on an explicit projection pins every generated target
 * column to the canonical application contract.
 */
export const orgPlanEntitlementsCanonicalWrites = pgTable(
  "org_plan_entitlements",
  orgPlanEntitlementCanonicalColumns(),
);
