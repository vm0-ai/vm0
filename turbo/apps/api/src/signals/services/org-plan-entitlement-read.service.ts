import { orgTierSchema } from "@vm0/api-contracts/contracts/orgs";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgPlanEntitlements } from "@vm0/db/schema/org-plan-entitlement";
import { eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { ORG_PLAN_ENTITLEMENT_TIER_VALUES } from "./org-plan-entitlement-tier-values";

type ReadDb = Pick<Db, "select">;

export interface OrgPlanCapabilities {
  readonly status: "active" | "suspended";
  readonly baseConcurrencyLimit: number;
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
  readonly audioLifetimeLimit: number | null;
  readonly audioDailyRateLimit: number;
  readonly audioDailyDurationSeconds: number;
}

const CAPABILITY_SELECTION = {
  status: orgPlanEntitlements.status,
  baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
  canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
  canBuyCredits: orgPlanEntitlements.canBuyCredits,
  autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
  supportByok: orgPlanEntitlements.supportByok,
  restrictedVm0Models: orgPlanEntitlements.restrictedVm0Models,
  videoGenerationAllowed: orgPlanEntitlements.videoGenerationAllowed,
  workflowWebhookAutomationAllowed:
    orgPlanEntitlements.workflowWebhookTriggerAllowed,
  audioLifetimeLimit: orgPlanEntitlements.audioLifetimeLimit,
  audioDailyRateLimit: orgPlanEntitlements.audioDailyRateLimit,
  audioDailyDurationSeconds: orgPlanEntitlements.audioDailyDurationSeconds,
} as const;

function runtimeStatusForEntitlement(
  status: string,
): OrgPlanCapabilities["status"] {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "atom_grant":
    case "manual_active": {
      return "active";
    }
    default: {
      return "suspended";
    }
  }
}

function capabilitiesForTier(tierValue: string): OrgPlanCapabilities {
  const tier = orgTierSchema.parse(tierValue);
  return {
    status: tier === "pro-suspend" ? "suspended" : "active",
    ...ORG_PLAN_ENTITLEMENT_TIER_VALUES[tier],
  };
}

export function orgPlanEntitlementReadsEnabled(orgId: string): boolean {
  return isFeatureEnabled(FeatureSwitchKey.OrgPlanEntitlementReads, { orgId });
}

export async function loadOrgPlanCapabilities(
  db: ReadDb,
  orgId: string,
  options?: { readonly forUpdate?: boolean },
): Promise<OrgPlanCapabilities | null> {
  if (orgPlanEntitlementReadsEnabled(orgId)) {
    const query = db
      .select(CAPABILITY_SELECTION)
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId))
      .limit(1);
    const [capabilities] = options?.forUpdate
      ? await query.for("update")
      : await query;
    if (!capabilities) {
      const orgQuery = db
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      const [org] = options?.forUpdate
        ? await orgQuery.for("update")
        : await orgQuery;
      if (!org) {
        return null;
      }
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    return {
      ...capabilities,
      status: runtimeStatusForEntitlement(capabilities.status),
    };
  }

  const query = db
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  const [org] = options?.forUpdate ? await query.for("update") : await query;
  if (!org) {
    return null;
  }

  return capabilitiesForTier(org.tier);
}
