import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  getInstructionsStorageName,
  getSkillStorageName as getCoreSkillStorageName,
  parseGitHubTreeUrl as parseGitHubTreeUrlCore,
  type ParsedGitHubTreeUrl,
} from "@vm0/core";

const execAsync = promisify(exec);

// Re-export from @vm0/core for convenience
export { getInstructionsStorageName };

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
 * Download a GitHub directory using git sparse-checkout
 *
 * @param parsed - Parsed GitHub URL
 * @param destDir - Destination directory for the downloaded content
 * @returns Path to the downloaded skill directory
 */
export async function downloadGitHubSkill(
  parsed: ParsedGitHubUrl,
  destDir: string,
): Promise<string> {
  const repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  const skillDir = path.join(destDir, parsed.skillName);

  // Create a temporary directory for sparse checkout
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vm0-skill-"));

  try {
    // Initialize sparse checkout
    await execAsync(`git init`, { cwd: tempDir });
    await execAsync(`git remote add origin "${repoUrl}"`, { cwd: tempDir });
    await execAsync(`git config core.sparseCheckout true`, { cwd: tempDir });

    // Configure sparse checkout to only fetch the skill path
    const sparseFile = path.join(tempDir, ".git", "info", "sparse-checkout");
    await fs.writeFile(sparseFile, parsed.path + "\n");

    // Fetch only the required branch
    await execAsync(`git fetch --depth 1 origin "${parsed.branch}"`, {
      cwd: tempDir,
    });
    await execAsync(`git checkout "${parsed.branch}"`, { cwd: tempDir });

    // Move the skill directory to destination
    const fetchedPath = path.join(tempDir, parsed.path);
    await fs.mkdir(path.dirname(skillDir), { recursive: true });
    await fs.rename(fetchedPath, skillDir);

    return skillDir;
  } finally {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
 * Parsed skill frontmatter from SKILL.md
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  vm0_secrets?: string[];
  vm0_vars?: string[];
}

/**
 * Parse frontmatter from SKILL.md content
 * Extracts YAML between --- markers at the start of the file
 *
 * @param content - Raw content of SKILL.md file
 * @returns Parsed frontmatter fields
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  // Match frontmatter between --- markers at the start of the file
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) {
    return {};
  }

  const yamlContent = frontmatterMatch[1];
  if (!yamlContent) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch {
    // Invalid YAML, return empty frontmatter
    return {};
  }

  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const data = parsed as Record<string, unknown>;

  // Validate and extract fields
  return {
    name: typeof data.name === "string" ? data.name : undefined,
    description:
      typeof data.description === "string" ? data.description : undefined,
    vm0_secrets: Array.isArray(data.vm0_secrets)
      ? data.vm0_secrets.filter((s): s is string => typeof s === "string")
      : undefined,
    vm0_vars: Array.isArray(data.vm0_vars)
      ? data.vm0_vars.filter((s): s is string => typeof s === "string")
      : undefined,
  };
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
