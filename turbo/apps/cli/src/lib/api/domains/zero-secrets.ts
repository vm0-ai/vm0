import { initClient } from "@ts-rest/core";
import {
  zeroSecretsContract,
  zeroSecretsByNameContract,
} from "@vm0/core/contracts/zero-secrets";
import type {
  SecretListResponse,
  SecretResponse,
} from "@vm0/core/contracts/secrets";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List user-level secrets via zero API (metadata only, no values)
 */
export async function listZeroSecrets(): Promise<SecretListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSecretsContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list secrets");
}

/**
 * Set (create or update) a user-level secret via zero API
 */
export async function setZeroSecret(body: {
  name: string;
  value: string;
  description?: string;
}): Promise<SecretResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSecretsContract, config);

  const result = await client.set({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set secret");
}

/**
 * Delete a user-level secret by name via zero API
 */
export async function deleteZeroSecret(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroSecretsByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Secret "${name}" not found`);
}
