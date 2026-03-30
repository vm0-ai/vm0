import {
  resolveSkillRef,
  getInstructionsFilename,
  CONNECTOR_TYPES,
  getCustomSkillStorageName,
} from "@vm0/core";
import { SEED_SKILLS } from "./seed-skills";

/**
 * Build compose content for a zero agent.
 *
 * Always includes all SEED_SKILLS plus all connector type skill names
 * (dynamically derived from CONNECTOR_TYPES so it never goes stale).
 * Connector env vars are injected at runtime by resolveConnectorSecrets,
 * not baked into the compose.
 */
export function buildComposeContent(
  agentName: string,
  customSkills: Array<{ name: string }> = [],
): Record<string, unknown> {
  // Validate custom skill names don't conflict with seed skills
  const seedSet = new Set<string>(SEED_SKILLS);
  for (const skill of customSkills) {
    if (seedSet.has(skill.name)) {
      throw new Error(
        `Custom skill name "${skill.name}" conflicts with a built-in skill`,
      );
    }
  }

  const allSkillNames = [
    ...new Set([...SEED_SKILLS, ...Object.keys(CONNECTOR_TYPES)]),
  ];
  const skills = allSkillNames.map((name) => resolveSkillRef(name));

  const environment: Record<string, string> = {
    ZERO_AGENT_ID: "${{ vars.ZERO_AGENT_ID }}",
    ZERO_TOKEN: "${{ secrets.ZERO_TOKEN }}",
  };

  // Build custom skill volumes
  const volumes: Record<string, unknown> = {};
  const agentVolumes: string[] = [];

  for (const skill of customSkills) {
    const volKey = `custom-skill-${skill.name}`;
    const storageName = getCustomSkillStorageName(skill.name);
    volumes[volKey] = { name: storageName, version: "latest" };
    agentVolumes.push(`${volKey}:/home/user/.claude/skills/${skill.name}`);
  }

  const agentDef: Record<string, unknown> = {
    framework: "claude-code",
    instructions: getInstructionsFilename("claude-code"),
    environment,
    volumes: agentVolumes,
  };

  if (skills.length > 0) {
    agentDef.skills = skills;
  }

  const result: Record<string, unknown> = {
    version: "1",
    agents: {
      [agentName]: agentDef,
    },
  };

  if (Object.keys(volumes).length > 0) {
    result.volumes = volumes;
  }

  return result;
}
