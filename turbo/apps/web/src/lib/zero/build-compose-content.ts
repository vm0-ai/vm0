import {
  resolveSkillRef,
  getInstructionsFilename,
  getConnectorEnvironmentMapping,
  connectorTypeSchema,
  CONNECTOR_TYPES,
  getCustomSkillStorageName,
} from "@vm0/core";
import { SEED_SKILLS } from "./seed-skills";

/**
 * Build compose content for a zero agent.
 *
 * Always includes all SEED_SKILLS plus connector type skill names that are
 * generally available (i.e. not gated behind a feature flag).
 * Connector env var templates are baked into the compose so that
 * expandEnvironmentFromCompose can resolve firewall placeholders at runtime.
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

  const gaConnectorTypes = Object.entries(CONNECTOR_TYPES)
    .filter(([, config]) => {
      return !config.featureFlag;
    })
    .map(([type]) => {
      return type;
    });

  const allSkillNames = [...new Set([...SEED_SKILLS, ...gaConnectorTypes])];
  const skills = allSkillNames.map((name) => {
    return resolveSkillRef(name);
  });

  const environment: Record<string, string> = {
    ZERO_AGENT_ID: "${{ vars.ZERO_AGENT_ID }}",
    ZERO_TOKEN: "${{ secrets.ZERO_TOKEN }}",
  };

  // Inject env var templates from connector environmentMappings so that
  // expandEnvironmentFromCompose can substitute firewall placeholders.
  for (const connector of gaConnectorTypes) {
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
