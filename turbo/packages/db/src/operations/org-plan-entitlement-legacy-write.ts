import { pgTable } from "drizzle-orm/pg-core";

import { orgPlanEntitlementLegacyColumns } from "../schema/org-plan-entitlement";

/**
 * #30162 old-database/new-application INSERT compatibility.
 *
 * Drizzle includes every mapped column in an INSERT target list, including
 * omitted nullable columns as DEFAULT. Keep active inserts on this legacy-only
 * projection until #28368 records that the pre-expand schema can no longer be
 * reached by a supported application deployment or rollback.
 */
export const orgPlanEntitlementsLegacyWrites = pgTable(
  "org_plan_entitlements",
  orgPlanEntitlementLegacyColumns(),
);
