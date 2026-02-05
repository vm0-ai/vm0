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
  parseGitHubUrl as parseGitHubUrlCore,
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
 * Result of downloading a GitHub directory
 */
interface GitHubDownloadResult {
  /** Path to the downloaded directory */
  dir: string;
  /** Path to the temp root directory (for cleanup) */
  tempRoot: string;
}

/**
 * Get the default branch of a GitHub repository using git ls-remote.
 * This avoids dependency on gh CLI and works with just git installed.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @returns Default branch name
 */
async function getDefaultBranch(owner: string, repo: string): Promise<string> {
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  try {
    // git ls-remote --symref outputs:
    // ref: refs/heads/main    HEAD
    // a1b2c3d...              HEAD
    const { stdout } = await execAsync(
      `git ls-remote --symref "${repoUrl}" HEAD`,
    );

    // Extract branch name from "ref: refs/heads/main" line
    const match = stdout.match(/ref: refs\/heads\/([^\s]+)/);
    if (!match) {
      throw new Error(
        `Could not determine default branch for ${owner}/${repo}`,
      );
    }
    return match[1]!;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("not found") ||
      message.includes("Repository not found")
    ) {
      throw new Error(`Repository not found: ${owner}/${repo}`);
    }
    if (
      message.includes("Authentication failed") ||
      message.includes("could not read Username")
    ) {
      throw new Error(
        `Cannot access repository ${owner}/${repo}. Is it private?`,
      );
    }
    throw error;
  }
}

/**
 * Download a GitHub directory using git sparse-checkout.
 * Returns paths to both the downloaded directory and the temp root for cleanup.
 *
 * Supports multiple URL formats:
 * - https://github.com/owner/repo (plain repo, uses default branch, downloads root)
 * - https://github.com/owner/repo/tree/branch (root directory with explicit branch)
 * - https://github.com/owner/repo/tree/branch/path (subdirectory)
 *
 * @param url - GitHub URL
 * @returns Object with dir (downloaded path) and tempRoot (for cleanup)
 */
export async function downloadGitHubDirectory(
  url: string,
): Promise<GitHubDownloadResult> {
  const parsed = parseGitHubUrlCore(url);
  if (!parsed) {
    throw new Error(
      `Invalid GitHub URL: ${url}. Expected format: https://github.com/{owner}/{repo}[/tree/{branch}[/path]]`,
    );
  }

  const repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vm0-github-"));

  try {
    // Check git is available
    try {
      await execAsync("git --version");
    } catch {
      throw new Error(
        "git command not found. Please install git to use GitHub URLs.",
      );
    }

    // Resolve branch if not specified
    const branch =
      parsed.branch ?? (await getDefaultBranch(parsed.owner, parsed.repo));

    // Initialize sparse checkout
    await execAsync(`git init`, { cwd: tempDir });
    await execAsync(`git remote add origin "${repoUrl}"`, { cwd: tempDir });
    await execAsync(`git config core.sparseCheckout true`, { cwd: tempDir });

    // Configure sparse checkout pattern
    // For root: use "/*" to get all root-level files
    // For path: use the path directly
    const sparsePattern = parsed.path ?? "/*";
    const sparseFile = path.join(tempDir, ".git", "info", "sparse-checkout");
    await fs.writeFile(sparseFile, sparsePattern + "\n");

    // Fetch only the required branch with better error handling
    try {
      await execAsync(`git fetch --depth 1 origin "${branch}"`, {
        cwd: tempDir,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("Authentication failed") ||
        message.includes("could not read Username")
      ) {
        throw new Error(`Cannot access repository. Is it private? URL: ${url}`);
      }
      if (message.includes("couldn't find remote ref")) {
        throw new Error(`Branch "${branch}" not found in repository: ${url}`);
      }
      throw error;
    }

    await execAsync(`git checkout "${branch}"`, { cwd: tempDir });

    // Return directory path
    // For root: return tempDir directly
    // For path: return tempDir/path
    const downloadedDir = parsed.path
      ? path.join(tempDir, parsed.path)
      : tempDir;

    return {
      dir: downloadedDir,
      tempRoot: tempDir,
    };
  } catch (error) {
    // Clean up on error
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
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
function parseSkillFrontmatter(content: string): SkillFrontmatter {
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
