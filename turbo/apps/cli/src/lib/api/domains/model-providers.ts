import { initClient } from "@ts-rest/core";
import {
  modelProvidersMainContract,
  modelProvidersCheckContract,
  modelProvidersByTypeContract,
  modelProvidersSetDefaultContract,
  modelProvidersUpdateModelContract,
  type ModelProviderType,
  type ModelProviderListResponse,
  type ModelProviderResponse,
  type UpsertModelProviderResponse,
  type CheckSecretResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List all model providers
 */
export async function listModelProviders(): Promise<ModelProviderListResponse> {
  const config = await getClientConfig();
  const client = initClient(modelProvidersMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list model providers");
}

/**
 * Create or update a model provider
 */
export async function upsertModelProvider(body: {
  type: ModelProviderType;
  // Legacy single secret
  secret?: string;
  // Multi-auth support
  authMethod?: string;
  secrets?: Record<string, string>;
  selectedModel?: string;
}): Promise<UpsertModelProviderResponse> {
  const config = await getClientConfig();
  const client = initClient(modelProvidersMainContract, config);

  const result = await client.upsert({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set model provider");
}

/**
 * Check if secret exists for a model provider type
 */
export async function checkModelProviderSecret(
  type: ModelProviderType,
): Promise<CheckSecretResponse> {
  const config = await getClientConfig();
  const client = initClient(modelProvidersCheckContract, config);

  const result = await client.check({
    params: { type },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to check secret");
}

/**
 * Delete a model provider
 */
export async function deleteModelProvider(
  type: ModelProviderType,
): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(modelProvidersByTypeContract, config);

  const result = await client.delete({
    params: { type },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Model provider "${type}" not found`);
}

/**
 * Set a model provider as default for its framework
 */
export async function setModelProviderDefault(
  type: ModelProviderType,
): Promise<ModelProviderResponse> {
  const config = await getClientConfig();
  const client = initClient(modelProvidersSetDefaultContract, config);

  const result = await client.setDefault({
    params: { type },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to set default model provider");
}

/**
 * Update model selection for an existing provider (keeps credential unchanged)
 */
export async function updateModelProviderModel(
  type: ModelProviderType,
  selectedModel?: string,
): Promise<ModelProviderResponse> {
  const config = await getClientConfig();
  const client = initClient(modelProvidersUpdateModelContract, config);

  const result = await client.updateModel({
    params: { type },
    body: { selectedModel },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to update model provider");
}
