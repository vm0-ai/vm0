import { initClient } from "@ts-rest/core";
import { orgSecretsMainContract, orgSecretsByNameContract } from "@vm0/core";
import type { SecretResponse, SecretListResponse } from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List org-level secrets (metadata only, no values)
 */
export async function listOrgSecrets(): Promise<SecretListResponse> {
  const config = await getClientConfig();
  const client = initClient(orgSecretsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list org secrets");
}

/**
 * Set (create or update) an org-level secret
 */
export async function setOrgSecret(body: {
  name: string;
  value: string;
  description?: string;
}): Promise<SecretResponse> {
  const config = await getClientConfig();
  const client = initClient(orgSecretsMainContract, config);

  const result = await client.set({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set org secret");
}

/**
 * Delete an org-level secret by name
 */
export async function deleteOrgSecret(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgSecretsByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Org secret "${name}" not found`);
}
