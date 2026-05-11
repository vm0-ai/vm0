import { computed } from "ccstate";
import type {
  ModelProviderResponse,
  OrgModelPoliciesResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
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
  async (get): Promise<ModelFirstPersonalOauthState | null> => {
    const features = get(featureSwitch$);
    if (!(features?.[FeatureSwitchKey.ModelFirstModelProvider] ?? false)) {
      return null;
    }

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
