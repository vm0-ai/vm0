import { initClient } from "@ts-rest/core";
import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
  type ZeroAgentCustomSkill,
  type ZeroAgentSkillContentResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listSkills(): Promise<ZeroAgentCustomSkill[]> {
  const config = await getClientConfig();
  const client = initClient(zeroSkillsCollectionContract, config);
  const result = await client.list();
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list skills");
}

export async function createSkill(body: {
  name: string;
  content: string;
  displayName?: string;
  description?: string;
}): Promise<ZeroAgentCustomSkill> {
  const config = await getClientConfig();
  const client = initClient(zeroSkillsCollectionContract, config);
  const result = await client.create({ body });
  if (result.status === 201) return result.body;
  handleError(result, `Failed to create skill "${body.name}"`);
}

export async function getSkill(
  name: string,
): Promise<ZeroAgentSkillContentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSkillsDetailContract, config);
  const result = await client.get({ params: { name } });
  if (result.status === 200) return result.body;
  handleError(result, `Skill "${name}" not found`);
}

export async function updateSkill(
  name: string,
  body: { content: string },
): Promise<ZeroAgentSkillContentResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSkillsDetailContract, config);
  const result = await client.update({ params: { name }, body });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update skill "${name}"`);
}

export async function deleteSkill(name: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroSkillsDetailContract, config);
  const result = await client.delete({ params: { name } });
  if (result.status === 204) return;
  handleError(result, `Skill "${name}" not found`);
}
