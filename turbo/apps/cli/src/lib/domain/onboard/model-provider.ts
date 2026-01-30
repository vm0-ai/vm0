import {
  MODEL_PROVIDER_TYPES,
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
 */
export function getProviderChoices(): ProviderChoice[] {
  return (Object.keys(MODEL_PROVIDER_TYPES) as ModelProviderType[]).map(
    (type) => ({
      type,
      label: MODEL_PROVIDER_TYPES[type].label,
      helpText: MODEL_PROVIDER_TYPES[type].helpText,
      credentialLabel: MODEL_PROVIDER_TYPES[type].credentialLabel,
    }),
  );
}

/**
 * Setup a model provider with the given credential
 */
export async function setupModelProvider(
  type: ModelProviderType,
  credential: string,
  options?: { convert?: boolean },
): Promise<SetupResult> {
  const response: UpsertModelProviderResponse = await upsertModelProvider({
    type,
    credential,
    convert: options?.convert,
  });

  return {
    provider: response.provider,
    created: response.created,
    isDefault: response.provider.isDefault,
    framework: response.provider.framework,
  };
}
