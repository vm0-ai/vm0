import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/billing";
import { computed } from "ccstate";

import {
  apiTierToBillingTier,
  billingStatusAsync$,
  type BillingTier,
} from "./billing.ts";

export interface OrgPlanCapabilities {
  readonly status: "active" | "suspended";
  /** Remove after APIs without billing status are below the rollback floor. */
  readonly legacyMemberInvitationAllowed: boolean | null;
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly showUsagePack: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
}

const LEGACY_TIER_CAPABILITIES: Readonly<
  Record<BillingTier, Omit<OrgPlanCapabilities, "showUsagePack">>
> = {
  free: {
    canBuyConcurrency: false,
    canBuyCredits: true,
    status: "active",
    legacyMemberInvitationAllowed: false,
    autoRechargeAllowed: false,
    supportByok: true,
    restrictedVm0Models: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: false,
  },
  "limited-free-1": {
    canBuyConcurrency: false,
    canBuyCredits: false,
    status: "active",
    legacyMemberInvitationAllowed: false,
    autoRechargeAllowed: false,
    supportByok: false,
    restrictedVm0Models: true,
    videoGenerationAllowed: false,
    workflowWebhookAutomationAllowed: false,
  },
  "pro-suspend": {
    canBuyConcurrency: false,
    canBuyCredits: false,
    status: "suspended",
    legacyMemberInvitationAllowed: false,
    autoRechargeAllowed: false,
    // Preserve the model picker behavior of browsers talking to an older API.
    // New APIs always return these two capabilities explicitly.
    supportByok: true,
    restrictedVm0Models: false,
    videoGenerationAllowed: false,
    workflowWebhookAutomationAllowed: false,
  },
  pro: {
    canBuyConcurrency: false,
    canBuyCredits: true,
    status: "active",
    legacyMemberInvitationAllowed: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedVm0Models: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: false,
  },
  team: {
    canBuyConcurrency: true,
    canBuyCredits: true,
    status: "active",
    legacyMemberInvitationAllowed: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedVm0Models: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: true,
  },
  custom: {
    canBuyConcurrency: true,
    canBuyCredits: true,
    status: "active",
    legacyMemberInvitationAllowed: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedVm0Models: false,
    videoGenerationAllowed: true,
    workflowWebhookAutomationAllowed: true,
  },
};

export function orgPlanCapabilitiesFromBilling(
  billing: BillingStatusResponse,
): OrgPlanCapabilities {
  const fallback = LEGACY_TIER_CAPABILITIES[apiTierToBillingTier(billing.tier)];
  const hasCurrentStatus = billing.status !== undefined;
  return {
    canBuyConcurrency: billing.canBuyConcurrency ?? fallback.canBuyConcurrency,
    canBuyCredits: billing.canBuyCredits ?? fallback.canBuyCredits,
    showUsagePack: billing.showUsagePack,
    status: billing.status ?? fallback.status,
    legacyMemberInvitationAllowed: hasCurrentStatus
      ? null
      : (billing.memberInvitationAllowed ??
        fallback.legacyMemberInvitationAllowed),
    autoRechargeAllowed:
      billing.autoRechargeAllowed ?? fallback.autoRechargeAllowed,
    supportByok: billing.supportByok ?? fallback.supportByok,
    restrictedVm0Models:
      billing.restrictedVm0Models ?? fallback.restrictedVm0Models,
    videoGenerationAllowed:
      billing.videoGenerationAllowed ?? fallback.videoGenerationAllowed,
    workflowWebhookAutomationAllowed:
      billing.workflowWebhookAutomationAllowed ??
      fallback.workflowWebhookAutomationAllowed,
  };
}

export const orgPlanCapabilities$ = computed(async (get) => {
  return orgPlanCapabilitiesFromBilling(await get(billingStatusAsync$));
});
