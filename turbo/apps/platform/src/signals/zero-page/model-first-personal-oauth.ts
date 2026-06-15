import { computed } from "ccstate";
import type {
  ModelProviderResponse,
  OrgModelPoliciesResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { personalModelProviders$ } from "../external/personal-model-providers.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";

export interface ModelFirstPersonalOauthState {
  policies: OrgModelPoliciesResponse;
  personalProviders: ModelProviderResponse[];
  userModelPreference: {
    selectedModel: string | null;
  };
}

export const modelFirstPersonalOauthState$ = computed(
  async (get): Promise<ModelFirstPersonalOauthState> => {
    const [policies, personal, userModelPreference] = await Promise.all([
      get(orgModelPolicies$),
      get(personalModelProviders$),
      get(userModelPreference$),
    ]);
    return {
      policies,
      personalProviders: personal.modelProviders,
      userModelPreference,
    };
  },
);
