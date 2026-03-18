import { initClient } from "@ts-rest/core";
import {
  orgVariablesMainContract,
  orgVariablesByNameContract,
} from "@vm0/core";
import type { VariableResponse, VariableListResponse } from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List org-level variables (includes values)
 */
export async function listOrgVariables(): Promise<VariableListResponse> {
  const config = await getClientConfig();
  const client = initClient(orgVariablesMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list org variables");
}

/**
 * Set (create or update) an org-level variable
 */
export async function setOrgVariable(body: {
  name: string;
  value: string;
  description?: string;
}): Promise<VariableResponse> {
  const config = await getClientConfig();
  const client = initClient(orgVariablesMainContract, config);

  const result = await client.set({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set org variable");
}

/**
 * Delete an org-level variable by name
 */
export async function deleteOrgVariable(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgVariablesByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Org variable "${name}" not found`);
}
