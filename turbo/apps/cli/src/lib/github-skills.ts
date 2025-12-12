import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Parsed GitHub tree URL components
 */
export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  skillName: string; // Last segment of path (used for mount directory name)
  fullPath: string; // Full path after github.com/ (unique identifier)
}

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
  // First, extract the full path after github.com/ (always correct)
  const fullPathMatch = url.match(/^https:\/\/github\.com\/(.+)$/);
  if (!fullPathMatch) {
    throw new Error(
      `Invalid GitHub URL: ${url}. Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}`,
    );
  }
  const fullPath = fullPathMatch[1]!;

  // Parse components (may be incorrect for branches with slashes)
  const regex =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/;
  const match = url.match(regex);

  if (!match) {
    throw new Error(
      `Invalid GitHub tree URL: ${url}. Expected format: https://github.com/{owner}/{repo}/tree/{branch}/{path}`,
    );
  }

  const [, owner, repo, branch, pathPart] = match;
  const pathSegments = pathPart!.split("/");
  const skillName = pathSegments[pathSegments.length - 1]!;

  return {
    owner: owner!,
    repo: repo!,
    branch: branch!,
    path: pathPart!,
    skillName,
    fullPath,
  };
}

/**
 * Generate the storage name for a system skill
 * Format: system-skill@{fullPath}
 *
 * @param parsed - Parsed GitHub URL
 * @returns Storage name for the skill
 */
export function getSkillStorageName(parsed: ParsedGitHubUrl): string {
  return `system-skill@${parsed.fullPath}`;
}

/**
 * Generate the storage name for a system prompt
 * Format: system-prompt@{composeName}
 *
 * @param composeName - Name of the compose (agent name)
 * @returns Storage name for the system prompt
 */
export function getSystemPromptStorageName(composeName: string): string {
  return `system-prompt@${composeName}`;
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
 * Download multiple skills in parallel
 *
 * @param skillUrls - Array of GitHub tree URLs
 * @param destDir - Destination directory for downloaded skills
 * @returns Map of skill URL to local path
 */
export async function downloadSkills(
  skillUrls: string[],
  destDir: string,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Create destination directory
  await fs.mkdir(destDir, { recursive: true });

  // Download skills in parallel
  const downloads = skillUrls.map(async (url) => {
    const parsed = parseGitHubTreeUrl(url);
    const skillPath = await downloadGitHubSkill(parsed, destDir);
    results.set(url, skillPath);
  });

  await Promise.all(downloads);
  return results;
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
