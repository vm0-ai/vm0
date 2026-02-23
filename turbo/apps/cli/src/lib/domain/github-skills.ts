import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getInstructionsStorageName,
  getSkillStorageName as getCoreSkillStorageName,
  parseGitHubTreeUrl as parseGitHubTreeUrlCore,
  parseSkillFrontmatter,
  type ParsedGitHubTreeUrl,
  type SkillFrontmatter,
} from "@vm0/core";

// Re-export from @vm0/core for convenience
export { getInstructionsStorageName, type SkillFrontmatter };

// Re-export git operations from boundary module for backward compatibility
export {
  downloadGitHubSkill,
  downloadGitHubDirectory,
} from "../external/git-client";

// Re-export the type with the local name for backwards compatibility
type ParsedGitHubUrl = ParsedGitHubTreeUrl;

/**
 * Parse a GitHub tree URL into its components
 * Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}
 *
 * Note: Branch names containing slashes (e.g., feature/foo) may not parse correctly.
 * The fullPath field is always correct and used for unique storage naming.
 *
 * @param url - GitHub tree URL
 * @returns Parsed URL components
 * @throws Error if URL format is invalid
 */
export function parseGitHubTreeUrl(url: string): ParsedGitHubUrl {
  const parsed = parseGitHubTreeUrlCore(url);
  if (!parsed) {
    throw new Error(
      `Invalid GitHub tree URL: ${url}. Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}`,
    );
  }
  return parsed;
}

/**
 * Generate the storage name for an agent skill
 * Format: agent-skills@{fullPath}
 *
 * @param parsed - Parsed GitHub URL
 * @returns Storage name for the skill
 */
export function getSkillStorageName(parsed: ParsedGitHubUrl): string {
  return getCoreSkillStorageName(parsed.fullPath);
}

/**
 * Validate that a downloaded skill has the required SKILL.md file
 *
 * @param skillDir - Path to the downloaded skill directory
 * @returns True if valid, throws error otherwise
 */
export async function validateSkillDirectory(skillDir: string): Promise<void> {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  try {
    await fs.access(skillMdPath);
  } catch {
    throw new Error(
      `Skill directory missing required SKILL.md file: ${skillDir}`,
    );
  }
}

/**
 * Read and parse SKILL.md frontmatter from a skill directory
 *
 * @param skillDir - Path to the skill directory
 * @returns Parsed frontmatter fields
 */
export async function readSkillFrontmatter(
  skillDir: string,
): Promise<SkillFrontmatter> {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const content = await fs.readFile(skillMdPath, "utf8");
  return parseSkillFrontmatter(content);
}
