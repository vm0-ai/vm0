import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  extractVariableReferences as extractVariableReferencesCore,
  groupVariablesBySource,
} from "@vm0/core";
import {
  parseGitHubTreeUrl,
  downloadGitHubSkill,
  readSkillFrontmatter,
  type SkillFrontmatter,
} from "./github-skills";

/**
 * Agent definition from compose content
 */
interface AgentDefinition {
  description?: string;
  image?: string;
  framework: string;
  apps?: string[];
  volumes?: string[];
  working_dir?: string;
  environment?: Record<string, string>;
  instructions?: string;
  skills?: string[];
  experimental_runner?: {
    group: string;
  };
}

/**
 * Agent compose content structure
 */
interface AgentComposeContent {
  version: string;
  agents: Record<string, AgentDefinition>;
  volumes?: Record<string, { name: string; version: string }>;
}

/**
 * Source of a variable or secret
 */
interface VariableSource {
  /** The variable/secret name */
  name: string;
  /** Source description (e.g., "agent environment" or "skill: openai-skill") */
  source: string;
  /** The skill name if sourced from a skill */
  skillName?: string;
}

/**
 * Variable sources for an agent
 */
export interface AgentVariableSources {
  secrets: VariableSource[];
  vars: VariableSource[];
  credentials: VariableSource[];
}

/**
 * Download a skill and parse its frontmatter
 * Returns null if download or parsing fails
 */
async function fetchSkillFrontmatter(
  skillUrl: string,
  tempDir: string,
): Promise<{ skillName: string; frontmatter: SkillFrontmatter } | null> {
  try {
    const parsed = parseGitHubTreeUrl(skillUrl);
    const skillDir = await downloadGitHubSkill(parsed, tempDir);
    const frontmatter = await readSkillFrontmatter(skillDir);
    return { skillName: parsed.skillName, frontmatter };
  } catch {
    // Skill download or parsing failed, return null
    return null;
  }
}

/**
 * Derive variable sources for an agent by analyzing skill frontmatter
 *
 * This function downloads each skill declared in the agent's skills array,
 * parses the SKILL.md frontmatter, and determines which secrets/vars
 * are declared by which skills.
 *
 * @param agent - The agent definition
 * @param options - Options for derivation
 * @returns Variable sources with skill attribution
 */
async function deriveAgentVariableSources(
  agent: AgentDefinition,
  options?: { skipNetwork?: boolean },
): Promise<AgentVariableSources> {
  // Extract all variable references from environment using @vm0/core
  const refs = agent.environment
    ? extractVariableReferencesCore(agent.environment)
    : [];
  const grouped = groupVariablesBySource(refs);

  // Initialize all sources as "agent environment"
  const secretSources = new Map<string, VariableSource>();
  const varSources = new Map<string, VariableSource>();
  const credentialSources = new Map<string, VariableSource>();

  for (const ref of grouped.secrets) {
    secretSources.set(ref.name, {
      name: ref.name,
      source: "agent environment",
    });
  }
  for (const ref of grouped.vars) {
    varSources.set(ref.name, { name: ref.name, source: "agent environment" });
  }
  for (const ref of grouped.credentials) {
    credentialSources.set(ref.name, {
      name: ref.name,
      source: "agent environment",
    });
  }

  // If no skills or skipping network, return early
  if (options?.skipNetwork || !agent.skills || agent.skills.length === 0) {
    return {
      secrets: Array.from(secretSources.values()),
      vars: Array.from(varSources.values()),
      credentials: Array.from(credentialSources.values()),
    };
  }

  // Create temp directory for skill downloads
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "vm0-source-derivation-"),
  );

  try {
    // Download all skills in parallel
    const skillResults = await Promise.all(
      agent.skills.map((url) => fetchSkillFrontmatter(url, tempDir)),
    );

    // Process each skill's frontmatter
    for (const result of skillResults) {
      if (!result) continue;

      const { skillName, frontmatter } = result;

      // Update source for secrets declared by this skill
      if (frontmatter.vm0_secrets) {
        for (const secretName of frontmatter.vm0_secrets) {
          if (secretSources.has(secretName)) {
            secretSources.set(secretName, {
              name: secretName,
              source: `skill: ${skillName}`,
              skillName,
            });
          }
        }
      }

      // Update source for vars declared by this skill
      if (frontmatter.vm0_vars) {
        for (const varName of frontmatter.vm0_vars) {
          if (varSources.has(varName)) {
            varSources.set(varName, {
              name: varName,
              source: `skill: ${skillName}`,
              skillName,
            });
          }
        }
      }
    }
  } finally {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  return {
    secrets: Array.from(secretSources.values()),
    vars: Array.from(varSources.values()),
    credentials: Array.from(credentialSources.values()),
  };
}

/**
 * Derive variable sources for all agents in a compose
 *
 * @param content - The compose content
 * @param options - Options for derivation
 * @returns Map of agent name to variable sources
 */
export async function deriveComposeVariableSources(
  content: AgentComposeContent,
  options?: { skipNetwork?: boolean },
): Promise<Map<string, AgentVariableSources>> {
  const results = new Map<string, AgentVariableSources>();

  // Process all agents in parallel
  const entries = Object.entries(content.agents);
  const sourcesPromises = entries.map(async ([agentName, agent]) => {
    const sources = await deriveAgentVariableSources(agent, options);
    return { agentName, sources };
  });

  const sourcesResults = await Promise.all(sourcesPromises);
  for (const { agentName, sources } of sourcesResults) {
    results.set(agentName, sources);
  }

  return results;
}
