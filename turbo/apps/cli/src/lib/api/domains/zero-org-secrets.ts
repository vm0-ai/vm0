import { initClient } from "@ts-rest/core";
import {
  zeroSecretsContract,
  zeroSecretsByNameContract,
} from "@vm0/core/contracts/zero-secrets";
import type {
  SecretResponse,
  SecretListResponse,
} from "@vm0/core/contracts/secrets";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List org-level secrets via zero API (metadata only, no values)
 */
export async function listZeroOrgSecrets(): Promise<SecretListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSecretsContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list org secrets");
}

/**
 * Set (create or update) an org-level secret via zero API
 */
export async function setZeroOrgSecret(body: {
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

  handleError(result, "Failed to set org secret");
}

/**
 * Delete an org-level secret by name via zero API
 */
export async function deleteZeroOrgSecret(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroSecretsByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Org secret "${name}" not found`);
}
