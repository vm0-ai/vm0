import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  parseGitHubUrl as parseGitHubUrlCore,
  type ParsedGitHubTreeUrl,
} from "@vm0/core";

const execAsync = promisify(exec);

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
 * Download a GitHub directory using git sparse-checkout
 *
 * @param parsed - Parsed GitHub URL
 * @param destDir - Destination directory for the downloaded content
 * @returns Path to the downloaded skill directory
 */
export async function downloadGitHubSkill(
  parsed: ParsedGitHubTreeUrl,
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
    // For root: use "/*" to get all root-level files
    // For path: use the path directly
    const sparsePattern = parsed.path || "/*";
    const sparseFile = path.join(tempDir, ".git", "info", "sparse-checkout");
    await fs.writeFile(sparseFile, sparsePattern + "\n");

    // Fetch only the required branch
    await execAsync(`git fetch --depth 1 origin "${parsed.branch}"`, {
      cwd: tempDir,
    });
    await execAsync(`git checkout "${parsed.branch}"`, { cwd: tempDir });

    // Move the skill directory to destination
    await fs.mkdir(path.dirname(skillDir), { recursive: true });
    if (parsed.path) {
      // Subdirectory: move the fetched subdirectory
      const fetchedPath = path.join(tempDir, parsed.path);
      await fs.rename(fetchedPath, skillDir);
    } else {
      // Root: move all entries except .git from tempDir
      await fs.mkdir(skillDir, { recursive: true });
      const entries = await fs.readdir(tempDir);
      for (const entry of entries) {
        if (entry === ".git") continue;
        await fs.rename(path.join(tempDir, entry), path.join(skillDir, entry));
      }
    }

    return skillDir;
  } finally {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
