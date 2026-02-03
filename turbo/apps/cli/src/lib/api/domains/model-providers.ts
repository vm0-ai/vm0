import { initClient } from "@ts-rest/core";
import {
  modelProvidersMainContract,
  modelProvidersCheckContract,
  modelProvidersByTypeContract,
  modelProvidersConvertContract,
  modelProvidersSetDefaultContract,
  modelProvidersUpdateModelContract,
  type ModelProviderType,
  type ModelProviderListResponse,
  type ModelProviderResponse,
  type UpsertModelProviderResponse,
  type CheckCredentialResponse,
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
  // Legacy single credential (backward compat)
  credential?: string;
  // Multi-auth
  authMethod?: string;
  credentials?: Record<string, string>;
  // Common
  convert?: boolean;
  selectedModel?: string;
}): Promise<UpsertModelProviderResponse> {
  const config = await getClientConfig();
  const client = initClient(modelProvidersMainContract, config);

  // Transform multi-credential format to legacy format for API compatibility
  // The API currently expects a single 'credential' field
  let apiBody: {
    type: ModelProviderType;
    credential: string;
    convert?: boolean;
    selectedModel?: string;
    authMethod?: string;
  };

  if (body.credentials && body.authMethod) {
    // Multi-credential format: extract the primary credential
    const credentialValues = Object.values(body.credentials);
    const firstCredential = credentialValues[0];
    if (!firstCredential) {
      throw new Error("At least one credential is required");
    }
    // For now, pass the first credential as the main credential
    // and include all credentials in the body for future API support
    apiBody = {
      type: body.type,
      credential: firstCredential,
      convert: body.convert,
      selectedModel: body.selectedModel,
      authMethod: body.authMethod,
    };
  } else if (body.credential) {
    // Legacy single credential format
    apiBody = {
      type: body.type,
      credential: body.credential,
      convert: body.convert,
      selectedModel: body.selectedModel,
    };
  } else {
    throw new Error("Either credential or credentials must be provided");
  }

  const result = await client.upsert({ body: apiBody });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set model provider");
}

/**
 * Check if credential exists for a model provider type
 */
export async function checkModelProviderCredential(
  type: ModelProviderType,
): Promise<CheckCredentialResponse> {
  const config = await getClientConfig();
  const client = initClient(modelProvidersCheckContract, config);

  const result = await client.check({
    params: { type },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to check credential");
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
 * Convert existing user credential to model provider
 */
export async function convertModelProviderCredential(
  type: ModelProviderType,
): Promise<ModelProviderResponse> {
  const config = await getClientConfig();
  const client = initClient(modelProvidersConvertContract, config);

  const result = await client.convert({
    params: { type },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to convert credential");
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
