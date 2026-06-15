import { initClient } from "@ts-rest/core";
import {
  zeroAgentsMainContract,
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  type ZeroAgentResponse,
  type ZeroAgentRequest,
  type ZeroAgentInstructionsResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroUserPermissionGrantsContract,
  type UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { getClientConfig, handleError } from "../core/client-factory";

export async function createZeroAgent(
  body: ZeroAgentRequest,
): Promise<ZeroAgentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsMainContract, config);
  const result = await client.create({ body });
  if (result.status === 201) return result.body;
  handleError(result, "Failed to create zero agent");
}

export async function listZeroAgents(): Promise<ZeroAgentResponse[]> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsMainContract, config);
  const result = await client.list({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list zero agents");
}

export async function getZeroAgent(id: string): Promise<ZeroAgentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsByIdContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Zero agent "${id}" not found`);
}

export async function updateZeroAgent(
  id: string,
  body: ZeroAgentRequest,
): Promise<ZeroAgentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsByIdContract, config);
  const result = await client.update({ params: { id }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update zero agent "${id}"`);
}

export async function deleteZeroAgent(id: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsByIdContract, config);
  const result = await client.delete({ params: { id } });
  if (result.status === 204) return;
  handleError(result, `Zero agent "${id}" not found`);
}

export async function getZeroAgentInstructions(
  id: string,
): Promise<ZeroAgentInstructionsResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentInstructionsContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to get instructions for zero agent "${id}"`);
}

export async function getZeroAgentUserConnectors(
  id: string,
): Promise<string[]> {
  const config = await getClientConfig();
  const client = initClient(zeroUserConnectorsContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body.enabledTypes;
  handleError(
    result,
    `Failed to get connector permissions for zero agent "${id}"`,
  );
}

export async function listZeroUserPermissionGrants(
  agentId: string,
): Promise<UserPermissionGrantResponse[]> {
  const config = await getClientConfig();
  const client = initClient(zeroUserPermissionGrantsContract, config);
  const result = await client.list({ query: { agentId } });
  if (result.status === 200) return result.body;
  handleError(
    result,
    `Failed to get permission grants for zero agent "${agentId}"`,
  );
}

export async function updateZeroAgentInstructions(
  id: string,
  content: string,
): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentInstructionsContract, config);
  const result = await client.update({
    params: { id },
    body: { content },
  });
  if (result.status === 200) return;
  handleError(result, `Failed to update instructions for zero agent "${id}"`);
}
