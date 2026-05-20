import type { Getter, Setter } from "ccstate";
import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";

import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import { userModelPreference } from "./zero-user-data.service";

export interface IntegrationModelRoutePin {
  readonly modelProviderType: string;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: string;
}

export async function resolveIntegrationModelRouteForUser(args: {
  readonly get: Getter;
  readonly set: Setter;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<IntegrationModelRoutePin | undefined> {
  const preference = await args.get(
    userModelPreference({ orgId: args.orgId, userId: args.userId }),
  );
  args.signal.throwIfAborted();

  const policies = await args.set(
    listOrgModelPolicies$,
    { orgId: args.orgId, userId: args.userId },
    args.signal,
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
}
