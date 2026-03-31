import { initClient } from "@ts-rest/core";
import {
  zeroAgentSkillsCollectionContract,
  zeroAgentSkillsDetailContract,
  type ZeroAgentCustomSkill,
  type ZeroAgentSkillContentResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listAgentSkills(
  agentId: string,
): Promise<ZeroAgentCustomSkill[]> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentSkillsCollectionContract, config);
  const result = await client.list({ params: { id: agentId } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to list skills for agent "${agentId}"`);
}

export async function createAgentSkill(
  agentId: string,
  body: {
    name: string;
    content: string;
    displayName?: string;
    description?: string;
  },
): Promise<ZeroAgentCustomSkill> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentSkillsCollectionContract, config);
  const result = await client.create({ params: { id: agentId }, body });
  if (result.status === 201) return result.body;
  handleError(result, `Failed to create skill "${body.name}"`);
}

export async function getAgentSkill(
  agentId: string,
  name: string,
): Promise<ZeroAgentSkillContentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentSkillsDetailContract, config);
  const result = await client.get({ params: { id: agentId, name } });
  if (result.status === 200) return result.body;
  handleError(result, `Skill "${name}" not found`);
}

export async function updateAgentSkill(
  agentId: string,
  name: string,
  body: { content: string },
): Promise<ZeroAgentSkillContentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentSkillsDetailContract, config);
  const result = await client.update({ params: { id: agentId, name }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update skill "${name}"`);
}

export async function deleteAgentSkill(
  agentId: string,
  name: string,
): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroAgentSkillsDetailContract, config);
  const result = await client.delete({ params: { id: agentId, name } });
  if (result.status === 204) return;
  handleError(result, `Skill "${name}" not found`);
}
