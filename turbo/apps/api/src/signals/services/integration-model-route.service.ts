import { command } from "ccstate";
import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";

import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import { userModelPreference } from "./zero-user-data.service";

export interface IntegrationModelRoutePin {
  readonly modelProviderType: string;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: string;
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

    return {
      modelProviderType: routePolicy.defaultProviderType,
      modelProviderId: routePolicy.modelProviderId,
      modelProviderCredentialScope: routePolicy.credentialScope,
      selectedModel: routePolicy.model,
    };
  },
);
