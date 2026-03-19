import {
  resolveSkillRef,
  getInstructionsFilename,
  VALID_CAPABILITIES,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
} from "@vm0/core";

/**
 * Build compose content from connector short names.
 *
 * Maps connector short names to GitHub skill URLs and produces
 * compose content with hardcoded defaults per issue #5548.
 */
export function buildComposeContent(
  agentName: string,
  connectors: string[],
): Record<string, unknown> {
  const skills = connectors.map((c) => resolveSkillRef(c));

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

/**
 * Extract connector short names from compose content skills.
 *
 * Reverses the skill URL mapping: extracts the bare name from
 * GitHub URLs matching the vm0-skills pattern.
 */
export function extractConnectors(content: Record<string, unknown>): string[] {
  const agents = content.agents as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!agents) return [];

  const agentKey = Object.keys(agents)[0];
  if (!agentKey) return [];

  const agent = agents[agentKey];
  const skills = (agent?.skills ?? []) as string[];

  const prefix = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/`;
  return skills.map((url) =>
    url.startsWith(prefix) ? url.slice(prefix.length) : url,
  );
}
