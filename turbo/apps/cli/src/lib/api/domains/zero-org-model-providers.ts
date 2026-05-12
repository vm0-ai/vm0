import { initClient } from "@ts-rest/core";
import {
  zeroModelProvidersByTypeContract,
  zeroModelProvidersMainContract,
} from "@vm0/api-contracts/contracts/zero-model-providers";
import type {
  ModelProviderListResponse,
  ModelProviderType,
  UpsertModelProviderResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List all org-level model providers via zero API
 */
export async function listZeroOrgModelProviders(): Promise<ModelProviderListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroModelProvidersMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list org model providers");
}

/**
 * Create or update an org-level model provider via zero API (admin only)
 */
export async function upsertZeroOrgModelProvider(body: {
  type: ModelProviderType;
  secret?: string;
  authMethod?: string;
  secrets?: Record<string, string>;
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
 * Delete an org-level model provider via zero API (admin only)
 */
export async function deleteZeroOrgModelProvider(
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
