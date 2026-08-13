import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  zeroAgentsMainContract,
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  type ZeroAgentResponse,
  type ZeroAgentRequest,
  type ZeroAgentInstructionsResponse,
} from "@okouai/api-contracts/contracts/zero-agents";
import {
  zeroUserPermissionGrantsContract,
  type UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/zero-user-permission-grants";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { zeroUserConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  zeroAgentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/zero-agent-custom-connectors";
import { getClientConfig, handleError } from "../core/client-factory";

export type ZeroUserPermissionGrant = UserPermissionGrantResponse;

export async function createZeroAgent(
  body: ZeroAgentRequest,
): Promise<ZeroAgentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsMainContract, config);
  const result = await client.create({ body });
  if (result.status === 201) return result.body;
  handleError(result, "Failed to create agent");
}

export async function listZeroAgents(): Promise<ZeroAgentResponse[]> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsMainContract, config);
  const result = await client.list({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list agents");
}

export async function getZeroAgent(id: string): Promise<ZeroAgentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsByIdContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Agent "${id}" not found`);
}

export async function updateZeroAgent(
  id: string,
  body: ZeroAgentRequest,
): Promise<ZeroAgentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsByIdContract, config);
  const result = await client.update({ params: { id }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update agent "${id}"`);
}

export async function deleteZeroAgent(id: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsByIdContract, config);
  const result = await client.delete({ params: { id } });
  if (result.status === 204) return;
  handleError(result, `Agent "${id}" not found`);
}

export async function getZeroAgentInstructions(
  id: string,
): Promise<ZeroAgentInstructionsResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentInstructionsContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to get instructions for agent "${id}"`);
}

export async function getZeroAgentUserConnectors(
  id: string,
): Promise<ConnectorSlug[]> {
  const config = await getClientConfig();
  const client = initClient(zeroUserConnectorsContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) {
    return result.body.enabledConnectorSlugs;
  }
  handleError(result, `Failed to get connector permissions for agent "${id}"`);
}

export async function getZeroAgentCustomConnectorGrants(
  id: string,
): Promise<AgentCustomConnectorGrant[]> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentCustomConnectorsContract, config);
  const result = await client.get({ params: { id } });
  if (result.status === 200) return result.body.grants;
  handleError(
    result,
    `Failed to get custom connector permissions for agent "${id}"`,
  );
}

export async function listZeroUserPermissionGrants(
  agentId: string,
): Promise<ZeroUserPermissionGrant[]> {
  const config = await getClientConfig();
  const client = initClient(zeroUserPermissionGrantsContract, config);
  const result = await client.list({ query: { agentId } });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, `Failed to get permission grants for agent "${agentId}"`);
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
  handleError(result, `Failed to update instructions for agent "${id}"`);
}
