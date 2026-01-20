import {
  credentialsMainContract,
  credentialsByNameContract,
  type CredentialResponse,
  type CredentialListResponse,
} from "@vm0/core";
import {
  getClientConfig,
  createClient,
  handleError,
} from "../core/client-factory";

export async function listCredentials(): Promise<CredentialListResponse> {
  const config = await getClientConfig();
  const client = createClient(credentialsMainContract, config);

  const result = await client.list();

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list credentials");
}

export async function getCredential(name: string): Promise<CredentialResponse> {
  const config = await getClientConfig();
  const client = createClient(credentialsByNameContract, config);

  const result = await client.get({
    params: { name },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Credential "${name}" not found`);
}

export async function setCredential(body: {
  name: string;
  value: string;
  description?: string;
}): Promise<CredentialResponse> {
  const config = await getClientConfig();
  const client = createClient(credentialsMainContract, config);

  const result = await client.set({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set credential");
}

export async function deleteCredential(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = createClient(credentialsByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Credential "${name}" not found`);
}
