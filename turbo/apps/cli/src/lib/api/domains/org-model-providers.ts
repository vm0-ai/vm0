import { initClient } from "@ts-rest/core";
import {
  zeroModelProvidersMainContract,
  zeroModelProvidersByTypeContract,
  zeroModelProvidersDefaultContract,
  zeroModelProvidersUpdateModelContract,
  type ModelProviderType,
  type ModelProviderListResponse,
  type ModelProviderResponse,
  type UpsertModelProviderResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List all org-level model providers
 */
export async function listOrgModelProviders(): Promise<ModelProviderListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroModelProvidersMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list org model providers");
}

/**
 * Create or update an org-level model provider (admin only)
 */
export async function upsertOrgModelProvider(body: {
  type: ModelProviderType;
  secret?: string;
  authMethod?: string;
  secrets?: Record<string, string>;
  selectedModel?: string;
}): Promise<UpsertModelProviderResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroModelProvidersMainContract, config);

  const result = await client.upsert({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set org model provider");
}

/**
 * Delete an org-level model provider (admin only)
 */
export async function deleteOrgModelProvider(
  type: ModelProviderType,
): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroModelProvidersByTypeContract, config);

  const result = await client.delete({
    params: { type },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Org model provider "${type}" not found`);
}

/**
 * Set an org-level model provider as default for its framework (admin only)
 */
export async function setOrgModelProviderDefault(
  type: ModelProviderType,
): Promise<ModelProviderResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroModelProvidersDefaultContract, config);

  const result = await client.setDefault({
    params: { type },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to set default org model provider");
}

/**
 * Update model selection for an existing org-level provider (admin only)
 */
export async function updateOrgModelProviderModel(
  type: ModelProviderType,
  selectedModel?: string,
): Promise<ModelProviderResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroModelProvidersUpdateModelContract, config);

  const result = await client.updateModel({
    params: { type },
    body: { selectedModel },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to update org model provider");
}
