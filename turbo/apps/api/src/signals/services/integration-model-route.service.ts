import { command } from "ccstate";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import {
  getFrameworkForType,
  getVm0ConcreteProviderType,
  type ModelProviderCredentialScope,
} from "@vm0/api-contracts/contracts/model-providers";
import type { SupportedFramework } from "@vm0/core/frameworks";

import { writeDb$ } from "../external/db";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import { isCodexFastServiceTierSupported } from "./zero-model-selection.service";
import { userModelPreference } from "./zero-user-data.service";

export interface IntegrationModelRoutePin {
  readonly modelProviderType: string;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: string;
  readonly codexServiceTier: CodexServiceTier | null;
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

    const codexFastModeEnabled =
      preference.codexServiceTier === "fast"
        ? isFeatureEnabled(
            FeatureSwitchKey.CodexFastMode,
            await loadUserFeatureSwitchContext(
              set(writeDb$),
              args.orgId,
              args.userId,
            ),
          )
        : false;
    signal.throwIfAborted();
    const codexServiceTier = isCodexFastServiceTierSupported({
      selectedModel: routePolicy.model,
      effectiveModelProvider: routePolicy.defaultProviderType,
      codexFastModeEnabled,
    })
      ? "fast"
      : null;

    return {
      modelProviderType: routePolicy.defaultProviderType,
      modelProviderId:
        routePolicy.modelProviderSurfaceId ?? routePolicy.modelProviderId,
      modelProviderCredentialScope: routePolicy.credentialScope,
      selectedModel: routePolicy.model,
      codexServiceTier,
      cliAgentType: getFrameworkForType(
        routePolicy.defaultProviderType === "vm0"
          ? getVm0ConcreteProviderType(routePolicy.model)
          : routePolicy.defaultProviderType,
      ),
    };
  },
);
