import type { BillingStatusResponse } from "@vm0/api-contracts/contracts/zero-billing";
import { computed } from "ccstate";

import {
  apiTierToBillingTier,
  billingStatusAsync$,
  type BillingTier,
} from "./billing.ts";

export interface OrgPlanCapabilities {
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
}

const LEGACY_TIER_CAPABILITIES: Readonly<
  Record<BillingTier, OrgPlanCapabilities>
> = {
  free: {
    canBuyConcurrency: false,
    canBuyCredits: true,
    autoRechargeAllowed: false,
    supportByok: true,
    restrictedVm0Models: false,
    workflowWebhookAutomationAllowed: false,
  },
  "limited-free-1": {
    canBuyConcurrency: false,
    canBuyCredits: false,
    autoRechargeAllowed: false,
    supportByok: false,
    restrictedVm0Models: true,
    workflowWebhookAutomationAllowed: false,
  },
  "pro-suspend": {
    canBuyConcurrency: false,
    canBuyCredits: false,
    autoRechargeAllowed: false,
    // Preserve the model picker behavior of browsers talking to an older API.
    // New APIs always return these two capabilities explicitly.
    supportByok: true,
    restrictedVm0Models: false,
    workflowWebhookAutomationAllowed: false,
  },
  pro: {
    canBuyConcurrency: false,
    canBuyCredits: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedVm0Models: false,
    workflowWebhookAutomationAllowed: false,
  },
  team: {
    canBuyConcurrency: true,
    canBuyCredits: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedVm0Models: false,
    workflowWebhookAutomationAllowed: true,
  },
  custom: {
    canBuyConcurrency: true,
    canBuyCredits: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedVm0Models: false,
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
    autoRechargeAllowed:
      billing.autoRechargeAllowed ?? fallback.autoRechargeAllowed,
    supportByok: billing.supportByok ?? fallback.supportByok,
    restrictedVm0Models:
      billing.restrictedVm0Models ?? fallback.restrictedVm0Models,
    workflowWebhookAutomationAllowed:
      billing.workflowWebhookAutomationAllowed ??
      fallback.workflowWebhookAutomationAllowed,
  };
}

export const orgPlanCapabilities$ = computed(async (get) => {
  return orgPlanCapabilitiesFromBilling(await get(billingStatusAsync$));
});
