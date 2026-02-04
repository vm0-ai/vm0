import { initClient } from "@ts-rest/core";
import { variablesMainContract, variablesByNameContract } from "@vm0/core";
import type { VariableResponse, VariableListResponse } from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List variables (includes values)
 */
export async function listVariables(): Promise<VariableListResponse> {
  const config = await getClientConfig();
  const client = initClient(variablesMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list variables");
}

/**
 * Get variable by name (includes value)
 */
export async function getVariable(name: string): Promise<VariableResponse> {
  const config = await getClientConfig();
  const client = initClient(variablesByNameContract, config);

  const result = await client.get({
    params: { name },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Variable "${name}" not found`);
}

/**
 * Set (create or update) a variable
 */
export async function setVariable(body: {
  name: string;
  value: string;
  description?: string;
}): Promise<VariableResponse> {
  const config = await getClientConfig();
  const client = initClient(variablesMainContract, config);

  const result = await client.set({ body });

  if (result.status === 200 || result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to set variable");
}

/**
 * Delete a variable by name
 */
export async function deleteVariable(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(variablesByNameContract, config);

  const result = await client.delete({
    params: { name },
  });

  if (result.status === 204) {
    return;
  }

  handleError(result, `Variable "${name}" not found`);
}
