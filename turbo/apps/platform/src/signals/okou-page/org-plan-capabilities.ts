import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/billing";
import { computed } from "ccstate";

import {
  apiTierToBillingTier,
  billingStatusAsync$,
  type BillingTier,
} from "./billing.ts";

export interface OrgPlanCapabilities {
  readonly status: "active" | "suspended";
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
  return {
    canBuyConcurrency: billing.canBuyConcurrency ?? fallback.canBuyConcurrency,
    canBuyCredits: billing.canBuyCredits ?? fallback.canBuyCredits,
    showUsagePack: billing.showUsagePack,
    status: billing.status ?? fallback.status,
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
