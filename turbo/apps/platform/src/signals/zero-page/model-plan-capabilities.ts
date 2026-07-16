import { computed } from "ccstate";
import {
  isLimitedFree1RestrictedRunModel,
  type ModelProviderType,
  type OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";

import { billingStatusAsync$ } from "./billing.ts";

export interface ModelPlanCapabilities {
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
}

export const DEFAULT_MODEL_PLAN_CAPABILITIES =
  Object.freeze<ModelPlanCapabilities>({
    supportByok: true,
    restrictedVm0Models: false,
  });

export const modelPlanCapabilities$ = computed(
  async (get): Promise<ModelPlanCapabilities> => {
    const billing = await get(billingStatusAsync$);
    // Older API deployments only return the tier. Preserve the previous
    // frontend behavior while browser clients and API versions overlap.
    const legacyLimitedFree = billing.tier === "limited-free-1";
    return {
      supportByok: billing.supportByok ?? !legacyLimitedFree,
      restrictedVm0Models: billing.restrictedVm0Models ?? legacyLimitedFree,
    };
  },
);

export function modelAllowedForPlan(
  model: string | null | undefined,
  capabilities: Pick<ModelPlanCapabilities, "restrictedVm0Models">,
): boolean {
  return (
    !capabilities.restrictedVm0Models ||
    !isLimitedFree1RestrictedRunModel(model)
  );
}

function modelProviderAllowedForPlan(
  providerType: ModelProviderType,
  capabilities: Pick<ModelPlanCapabilities, "supportByok">,
): boolean {
  return capabilities.supportByok || providerType === "vm0";
}

export function modelPolicyAllowedForPlan(
  policy: Pick<OrgModelPolicy, "model" | "defaultProviderType">,
  capabilities: ModelPlanCapabilities,
): boolean {
  return (
    modelAllowedForPlan(policy.model, capabilities) &&
    modelProviderAllowedForPlan(policy.defaultProviderType, capabilities)
  );
}
