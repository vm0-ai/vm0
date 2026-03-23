import { initClient } from "@ts-rest/core";
import {
  zeroAgentsMainContract,
  zeroAgentsByNameContract,
  zeroAgentInstructionsContract,
  type ZeroAgentResponse,
  type ZeroAgentRequest,
  type ZeroAgentInstructionsResponse,
} from "@vm0/core";
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

export async function getZeroAgent(name: string): Promise<ZeroAgentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsByNameContract, config);
  const result = await client.get({ params: { name } });
  if (result.status === 200) return result.body;
  handleError(result, `Zero agent "${name}" not found`);
}

export async function updateZeroAgent(
  name: string,
  body: ZeroAgentRequest,
): Promise<ZeroAgentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsByNameContract, config);
  const result = await client.update({ params: { name }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update zero agent "${name}"`);
}

export async function deleteZeroAgent(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentsByNameContract, config);
  const result = await client.delete({ params: { name } });
  if (result.status === 204) return;
  handleError(result, `Zero agent "${name}" not found`);
}

export async function getZeroAgentInstructions(
  name: string,
): Promise<ZeroAgentInstructionsResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentInstructionsContract, config);
  const result = await client.get({ params: { name } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to get instructions for zero agent "${name}"`);
}

export async function updateZeroAgentInstructions(
  name: string,
  content: string,
): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentInstructionsContract, config);
  const result = await client.update({
    params: { name },
    body: { content },
  });
  if (result.status === 200) return;
  handleError(result, `Failed to update instructions for zero agent "${name}"`);
}
