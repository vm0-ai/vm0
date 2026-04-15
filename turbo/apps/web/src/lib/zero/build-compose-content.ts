import {
  resolveSkillRef,
  getInstructionsFilename,
  getConnectorEnvironmentMapping,
  getEligibleConnectorTypes,
  connectorTypeSchema,
} from "@vm0/core";
import { SEED_SKILLS } from "./seed-skills";

/**
 * Build compose content for a zero agent.
 *
 * Always includes all SEED_SKILLS plus eligible connector type skill names.
 * Eligible = GA (no feature flag) or has api-token auth (feature flag only
 * gates OAuth, not api-token).
 * Connector env var templates are baked into the compose so that
 * expandEnvironmentFromCompose can resolve firewall placeholders at runtime.
 */
export function buildComposeContent(
  agentName: string,
): Record<string, unknown> {
  const eligibleConnectorTypes = getEligibleConnectorTypes();

  const allSkillNames = [
    ...new Set([...SEED_SKILLS, ...eligibleConnectorTypes]),
  ];
  const skills = allSkillNames.map((name) => {
    return resolveSkillRef(name);
  });

  const environment: Record<string, string> = {
    ZERO_AGENT_ID: "${{ vars.ZERO_AGENT_ID }}",
    ZERO_TOKEN: "${{ secrets.ZERO_TOKEN }}",
  };

  // Inject env var templates from connector environmentMappings so that
  // expandEnvironmentFromCompose can substitute firewall placeholders.
  for (const connector of eligibleConnectorTypes) {
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

  const agentDef: Record<string, unknown> = {
    framework: "claude-code",
    instructions: getInstructionsFilename("claude-code"),
    environment,
  };

  if (skills.length > 0) {
    agentDef.skills = skills;
  }

  return {
    version: "1",
    agents: {
      [agentName]: agentDef,
    },
  };
}
