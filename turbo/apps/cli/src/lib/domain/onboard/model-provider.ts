import {
  MODEL_PROVIDER_TYPES,
  getModels,
  getDefaultModel,
  type ModelProviderType,
  type ModelProviderResponse,
  type UpsertModelProviderResponse,
} from "@vm0/core";

/**
 * Provider types available in onboard flow.
 * This is an explicit allowlist - new providers must be added here to appear in onboard.
 * For advanced providers (e.g., aws-bedrock), users should use `vm0 model-provider setup`.
 */
const ONBOARD_PROVIDER_TYPES: ModelProviderType[] = [
  "claude-code-oauth-token",
  "anthropic-api-key",
  "openrouter-api-key",
  "moonshot-api-key",
  "minimax-api-key",
  "deepseek-api-key",
];
import {
  listModelProviders,
  upsertModelProvider,
} from "../../api/domains/model-providers.js";

interface ModelProviderStatus {
  hasProvider: boolean;
  providers: ModelProviderResponse[];
}

interface ProviderChoice {
  type: ModelProviderType;
  label: string;
  helpText: string;
  secretLabel: string;
  models?: string[];
  defaultModel?: string;
}

interface SetupResult {
  provider: ModelProviderResponse;
  created: boolean;
  isDefault: boolean;
  framework: string;
}

/**
 * Check if user has any model providers configured
 */
export async function checkModelProviderStatus(): Promise<ModelProviderStatus> {
  const response = await listModelProviders();
  return {
    hasProvider: response.modelProviders.length > 0,
    providers: response.modelProviders,
  };
}

/**
 * Get available provider types as choices for onboard selection.
 * Only providers in ONBOARD_PROVIDER_TYPES are shown.
 * For advanced providers, use `vm0 model-provider setup`.
 */
export function getProviderChoices(): ProviderChoice[] {
  return ONBOARD_PROVIDER_TYPES.map((type) => {
    const config = MODEL_PROVIDER_TYPES[type];
    return {
      type,
      label: config.label,
      helpText: config.helpText,
      secretLabel: "secretLabel" in config ? config.secretLabel : "",
      models: getModels(type),
      defaultModel: getDefaultModel(type),
    };
  });
}

/**
 * Setup a model provider with the given secret
 */
export async function setupModelProvider(
  type: ModelProviderType,
  secret: string,
  options?: { selectedModel?: string },
): Promise<SetupResult> {
  const response: UpsertModelProviderResponse = await upsertModelProvider({
    type,
    secret,
    selectedModel: options?.selectedModel,
  });

  return {
    provider: response.provider,
    created: response.created,
    isDefault: response.provider.isDefault,
    framework: response.provider.framework,
  };
}
