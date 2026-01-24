import { initClient } from "@ts-rest/core";
import { credentialsMainContract, credentialsByNameContract } from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";
import type { CredentialResponse, CredentialListResponse } from "../core/types";

/**
 * List credentials (metadata only, no values)
 */
export async function listCredentials(): Promise<CredentialListResponse> {
  const config = await getClientConfig();
  const client = initClient(credentialsMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list credentials");
}

/**
 * Get credential by name (metadata only, no value)
 */
export async function getCredential(name: string): Promise<CredentialResponse> {
  const config = await getClientConfig();
  const client = initClient(credentialsByNameContract, config);

  const result = await client.get({
    params: { name },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Credential "${name}" not found`);
}

/**
 * Set (create or update) a credential
 */
export async function setCredential(body: {
  name: string;
  value: string;
  description?: string;
}): Promise<CredentialResponse> {
  const config = await getClientConfig();
  const client = initClient(credentialsMainContract, config);

  const result = await client.set({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set credential");
}

/**
 * Delete a credential by name
 */
export async function deleteCredential(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(credentialsByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Credential "${name}" not found`);
}
