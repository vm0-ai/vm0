import { initClient } from "@ts-rest/core";
import {
  zeroVariablesContract,
  zeroVariablesByNameContract,
} from "@vm0/core/contracts/zero-secrets";
import type {
  VariableResponse,
  VariableListResponse,
} from "@vm0/core/contracts/variables";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List org-level variables via zero API (includes values)
 */
export async function listZeroOrgVariables(): Promise<VariableListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroVariablesContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list org variables");
}

/**
 * Set (create or update) an org-level variable via zero API
 */
export async function setZeroOrgVariable(body: {
  name: string;
  value: string;
  description?: string;
}): Promise<VariableResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroVariablesContract, config);

  const result = await client.set({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set org variable");
}

/**
 * Delete an org-level variable by name via zero API
 */
export async function deleteZeroOrgVariable(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroVariablesByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Org variable "${name}" not found`);
}
