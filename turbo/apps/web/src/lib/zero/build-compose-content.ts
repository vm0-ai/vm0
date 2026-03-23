import {
  resolveSkillRef,
  getInstructionsFilename,
  VALID_CAPABILITIES,
  DEFAULT_SKILLS_OWNER,
  DEFAULT_SKILLS_REPO,
  DEFAULT_SKILLS_BRANCH,
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

/**
 * Extract connector short names from compose content skills.
 *
 * Reverses the skill URL mapping: extracts the bare name from
 * GitHub URLs matching the vm0-skills pattern.
 */
export function extractConnectors(content: unknown): string[] {
  const obj = typeof content === "object" && content !== null ? content : {};
  const agents = (obj as Record<string, unknown>).agents as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!agents) return [];

  const agentKey = Object.keys(agents)[0];
  if (!agentKey) return [];

  const agent = agents[agentKey];
  const skills = (agent?.skills ?? []) as string[];

  const prefix = `https://github.com/${DEFAULT_SKILLS_OWNER}/${DEFAULT_SKILLS_REPO}/tree/${DEFAULT_SKILLS_BRANCH}/`;
  const seedSet = new Set<string>(SEED_SKILLS);
  return skills
    .map((url) => (url.startsWith(prefix) ? url.slice(prefix.length) : url))
    .filter((name) => !seedSet.has(name));
}
