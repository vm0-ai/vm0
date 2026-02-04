import { initClient } from "@ts-rest/core";
import { secretsMainContract, secretsByNameContract } from "@vm0/core";
import type { SecretResponse, SecretListResponse } from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List secrets (metadata only, no values)
 */
export async function listSecrets(): Promise<SecretListResponse> {
  const config = await getClientConfig();
  const client = initClient(secretsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list secrets");
}

/**
 * Get secret by name (metadata only, no value)
 */
export async function getSecret(name: string): Promise<SecretResponse> {
  const config = await getClientConfig();
  const client = initClient(secretsByNameContract, config);

  const result = await client.get({
    params: { name },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Secret "${name}" not found`);
}

/**
 * Set (create or update) a secret
 */
export async function setSecret(body: {
  name: string;
  value: string;
  description?: string;
}): Promise<SecretResponse> {
  const config = await getClientConfig();
  const client = initClient(secretsMainContract, config);

  const result = await client.set({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set secret");
}

/**
 * Delete a secret by name
 */
export async function deleteSecret(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(secretsByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Secret "${name}" not found`);
}
