import {
  allowsCustomModel,
  getDefaultModel,
  getModels,
  type ModelProviderResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";

type ProviderTier = "personal" | "org";

interface AgentModelDefaultSource {
  modelProviderId: string | null;
  selectedModel: string | null;
  preferPersonalProvider?: boolean;
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
  tiers?: Map<string, ProviderTier>,
): ModelProviderSelection | null {
  const defaultProvider = providers.find((provider) => {
    return provider.isDefault && tiers?.get(provider.id) !== "personal";
  });
  return resolveProviderSelection(defaultProvider);
}

function resolvePersonalDefaultSelection(
  agent: AgentModelDefaultSource | null | undefined,
  providers: ModelProviderResponse[],
  tiers?: Map<string, ProviderTier>,
): ModelProviderSelection | null {
  if (!agent?.preferPersonalProvider || !tiers) {
    return null;
  }
  const personalDefault = providers.find((provider) => {
    return provider.isDefault && tiers.get(provider.id) === "personal";
  });
  return resolveProviderSelection(personalDefault, agent.selectedModel);
}

export function resolveEffectiveAgentDefaultSelection(params: {
  agent: AgentModelDefaultSource | null | undefined;
  providers: ModelProviderResponse[];
  tiers?: Map<string, ProviderTier>;
}): ModelProviderSelection | null {
  const personalDefault = resolvePersonalDefaultSelection(
    params.agent,
    params.providers,
    params.tiers,
  );
  if (personalDefault) {
    return personalDefault;
  }

  if (params.agent?.modelProviderId && params.agent.selectedModel) {
    return {
      modelProviderId: params.agent.modelProviderId,
      selectedModel: params.agent.selectedModel,
    };
  }

  return resolveWorkspaceDefaultSelection(params.providers, params.tiers);
}
