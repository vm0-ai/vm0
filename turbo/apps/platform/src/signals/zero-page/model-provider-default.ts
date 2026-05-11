import {
  allowsCustomModel,
  getDefaultModel,
  getModels,
  type ModelProviderResponse,
  type OrgModelPoliciesResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";

interface AgentModelDefaultSource {
  modelProviderId: string | null;
  selectedModel: string | null;
}

interface UserModelDefaultSource {
  selectedModel: string | null;
}

export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

function createModelFirstSelection(
  selectedModel: string | null | undefined,
): ModelProviderSelection | null {
  if (!selectedModel) {
    return null;
  }
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

function canProviderUseModel(
  provider: ModelProviderResponse,
  model: string | null | undefined,
): model is string {
  if (!model) {
    return false;
  }
  if (allowsCustomModel(provider.type)) {
    return true;
  }
  return getModels(provider.type)?.includes(model) ?? false;
}

function resolveProviderSelection(
  provider: ModelProviderResponse | undefined,
  fallbackSelectedModel?: string | null,
): ModelProviderSelection | null {
  if (!provider) {
    return null;
  }
  const compatibleFallback = canProviderUseModel(
    provider,
    fallbackSelectedModel,
  )
    ? fallbackSelectedModel
    : undefined;
  const selectedModel =
    provider.selectedModel ??
    compatibleFallback ??
    getDefaultModel(provider.type);
  if (!selectedModel) {
    return null;
  }
  return {
    modelProviderId: provider.id,
    selectedModel,
  };
}

export function resolveWorkspaceDefaultSelection(
  providers: ModelProviderResponse[],
): ModelProviderSelection | null {
  const defaultProvider = providers.find((provider) => {
    return provider.isDefault;
  });
  return resolveProviderSelection(defaultProvider);
}

export function resolveEffectiveAgentDefaultSelection(params: {
  agent: AgentModelDefaultSource | null | undefined;
  providers: ModelProviderResponse[];
}): ModelProviderSelection | null {
  if (params.agent?.modelProviderId && params.agent.selectedModel) {
    return {
      modelProviderId: params.agent.modelProviderId,
      selectedModel: params.agent.selectedModel,
    };
  }

  return resolveWorkspaceDefaultSelection(params.providers);
}

function resolveModelFirstWorkspaceDefaultSelection(
  policies: OrgModelPoliciesResponse | null | undefined,
): ModelProviderSelection | null {
  const defaultPolicy = policies?.policies.find((policy) => {
    return policy.isDefault && policy.routeStatus === "valid";
  });
  return createModelFirstSelection(
    defaultPolicy?.model ?? policies?.workspaceDefaultModel,
  );
}

export function resolveModelFirstUserDefaultSelection(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  policies: OrgModelPoliciesResponse | null | undefined;
}): ModelProviderSelection | null {
  return (
    createModelFirstSelection(params.userPreference?.selectedModel) ??
    resolveModelFirstWorkspaceDefaultSelection(params.policies)
  );
}
