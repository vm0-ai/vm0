import { initClient } from "@ts-rest/core";
import {
  zeroVariablesContract,
  zeroVariablesByNameContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import type {
  VariableListResponse,
  VariableResponse,
} from "@vm0/api-contracts/contracts/variables";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List user-level variables via zero API (includes values)
 */
export async function listZeroVariables(): Promise<VariableListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroVariablesContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list variables");
}

/**
 * Set (create or update) a user-level variable via zero API
 */
export async function setZeroVariable(body: {
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

  handleError(result, "Failed to set variable");
}

/**
 * Delete a user-level variable by name via zero API
 */
export async function deleteZeroVariable(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroVariablesByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Variable "${name}" not found`);
}
