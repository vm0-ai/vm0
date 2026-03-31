import {
  resolveSkillRef,
  getInstructionsFilename,
  getConnectorEnvironmentMapping,
  getCustomSkillStorageName,
  connectorTypeSchema,
} from "@vm0/core";
import { SEED_SKILLS } from "./seed-skills";

/**
 * Build compose content from connector short names.
 *
 * Merges SEED_SKILLS with user connectors (deduplicated) and maps
 * to GitHub skill URLs. Produces compose content with hardcoded
 * defaults per issue #5548. Injects connector environment variables
 * from each connector's environmentMapping.
 */
export function buildComposeContent(
  agentName: string,
  connectors: string[],
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

  const merged = [...new Set([...SEED_SKILLS, ...connectors])];
  const skills = merged.map((c) => resolveSkillRef(c));

  const environment: Record<string, string> = {
    ZERO_AGENT_ID: "${{ vars.ZERO_AGENT_ID }}",
    ZERO_TOKEN: "${{ secrets.ZERO_TOKEN }}",
  };

  // Inject env vars from connector environmentMappings
  for (const connector of connectors) {
    const parsed = connectorTypeSchema.safeParse(connector);
    if (!parsed.success) continue;
    const mapping = getConnectorEnvironmentMapping(parsed.data);
    for (const [envVar, valueRef] of Object.entries(mapping)) {
      if (envVar in environment) continue;
      if (valueRef.startsWith("$secrets.")) {
        environment[envVar] = `\${{ secrets.${envVar} }}`;
      } else if (valueRef.startsWith("$vars.")) {
        environment[envVar] = `\${{ vars.${envVar} }}`;
      }
    }
  }

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
