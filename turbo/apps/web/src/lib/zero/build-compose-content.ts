import {
  resolveSkillRef,
  getInstructionsFilename,
  getConnectorEnvironmentMapping,
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
): Record<string, unknown> {
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

  const agentDef: Record<string, unknown> = {
    framework: "claude-code",
    instructions: getInstructionsFilename("claude-code"),
    environment,
    volumes: [],
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
