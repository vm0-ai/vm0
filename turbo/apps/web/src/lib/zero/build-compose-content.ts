import {
  resolveSkillRef,
  getInstructionsFilename,
  VALID_CAPABILITIES,
} from "@vm0/core";
import { SEED_SKILLS } from "./seed-skills";

/**
 * Build compose content from connector short names.
 *
 * Merges SEED_SKILLS with user connectors (deduplicated) and maps
 * to GitHub skill URLs. Produces compose content with hardcoded
 * defaults per issue #5548.
 */
export function buildComposeContent(
  agentName: string,
  connectors: string[],
): Record<string, unknown> {
  const merged = [...new Set([...SEED_SKILLS, ...connectors])];
  const skills = merged.map((c) => resolveSkillRef(c));

  const agentDef: Record<string, unknown> = {
    framework: "claude-code",
    instructions: getInstructionsFilename("claude-code"),
    experimental_capabilities: [...VALID_CAPABILITIES],
    environment: {},
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
