import { pgTable } from "drizzle-orm/pg-core";

import { orgPlanEntitlementCanonicalColumns } from "../schema/org-plan-entitlement";

/**
 * Canonical-only application write projection for org plan entitlements.
 *
 * The released 1023 bridge mirrors this column into restricted_vm0_models for
 * the immediately previous application release and rollback builds. Keeping
 * the compatibility column out of this projection prevents application-level
 * dual writes and lets canonical input override the legacy column default.
 */
export const orgPlanEntitlementsCanonicalWrites = pgTable(
  "org_plan_entitlements",
  orgPlanEntitlementCanonicalColumns(),
);
