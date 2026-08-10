import { command } from "ccstate";
import {
  getFrameworkForType,
  getVm0ConcreteProviderType,
  type ModelProviderCredentialScope,
} from "@vm0/api-contracts/contracts/model-providers";
import type { ChatThreadServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import type { SupportedFramework } from "@vm0/core/frameworks";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import { userModelPreference } from "./zero-user-data.service";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { isCodexFastServiceTierSupported } from "./zero-model-selection.service";

export interface IntegrationModelRoutePin {
  readonly modelProviderType: string;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: string;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly cliAgentType: SupportedFramework;
}

export const resolveIntegrationModelRouteForUser$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<IntegrationModelRoutePin | undefined> => {
    const preference = await get(
      userModelPreference({ orgId: args.orgId, userId: args.userId }),
    );
    signal.throwIfAborted();

    const policies = await set(
      listOrgModelPolicies$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    const preferredPolicy = preference.selectedModel
      ? policies.policies.find((policy) => {
          return policy.model === preference.selectedModel;
        })
      : undefined;
    const defaultPolicy = policies.policies.find((policy) => {
      return policy.id === policies.workspaceDefaultPolicyId;
    });
    const routePolicy =
      preferredPolicy ??
      defaultPolicy ??
      policies.policies.find((policy) => {
        return policy.isDefault;
      });
    if (!routePolicy || routePolicy.routeStatus !== "valid") {
      return undefined;
    }

    const featureSwitchContext =
      preference.serviceTier === "priority" && routePolicy === preferredPolicy
        ? await get(userFeatureSwitchContext(args.orgId, args.userId))
        : null;
    signal.throwIfAborted();
    const serviceTier = isCodexFastServiceTierSupported({
      selectedModel: routePolicy.model,
      codexFastModeEnabled:
        featureSwitchContext !== null &&
        isFeatureEnabled(FeatureSwitchKey.CodexFastMode, featureSwitchContext),
    })
      ? "priority"
      : null;

    return {
      modelProviderType: routePolicy.defaultProviderType,
      modelProviderId:
        routePolicy.modelProviderSurfaceId ?? routePolicy.modelProviderId,
      modelProviderCredentialScope: routePolicy.credentialScope,
      selectedModel: routePolicy.model,
      serviceTier,
      cliAgentType: getFrameworkForType(
        routePolicy.defaultProviderType === "vm0"
          ? getVm0ConcreteProviderType(routePolicy.model)
          : routePolicy.defaultProviderType,
      ),
    };
  },
);
