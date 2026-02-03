import {
  MODEL_PROVIDER_TYPES,
  getModels,
  getDefaultModel,
  hasAuthMethods,
  type ModelProviderType,
  type ModelProviderResponse,
  type UpsertModelProviderResponse,
} from "@vm0/core";
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
  credentialLabel: string;
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
 * Get available provider types as choices for selection
 * Note: Multi-auth providers (like aws-bedrock) are excluded until CLI support is added
 */
export function getProviderChoices(): ProviderChoice[] {
  return (Object.keys(MODEL_PROVIDER_TYPES) as ModelProviderType[])
    .filter((type) => !hasAuthMethods(type)) // Exclude multi-auth providers for now
    .map((type) => {
      const config = MODEL_PROVIDER_TYPES[type];
      return {
        type,
        label: config.label,
        helpText: config.helpText,
        credentialLabel:
          "credentialLabel" in config ? config.credentialLabel : "",
        models: getModels(type),
        defaultModel: getDefaultModel(type),
      };
    });
}

/**
 * Setup a model provider with the given credential
 */
export async function setupModelProvider(
  type: ModelProviderType,
  credential: string,
  options?: { convert?: boolean; selectedModel?: string },
): Promise<SetupResult> {
  const response: UpsertModelProviderResponse = await upsertModelProvider({
    type,
    credential,
    convert: options?.convert,
    selectedModel: options?.selectedModel,
  });

  return {
    provider: response.provider,
    created: response.created,
    isDefault: response.provider.isDefault,
    framework: response.provider.framework,
  };
}
