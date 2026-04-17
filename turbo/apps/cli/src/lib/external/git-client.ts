import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseGitHubUrl as parseGitHubUrlCore } from "@vm0/core";

const execFileAsync = promisify(execFile);

/**
 * Sanitize a value intended as a git positional argument to prevent
 * second-order command injection via flags like `--upload-pack`.
 * Only allows safe characters (alphanumeric, dash, underscore, dot, slash).
 * Returns the value if safe; throws otherwise.
 */
function sanitizeGitArg(value: string, label: string): string {
  if (!/^[a-zA-Z0-9._/\-@]+$/.test(value)) {
    throw new Error(
      `Invalid ${label}: contains disallowed characters. Only alphanumeric, dash, underscore, dot, slash, and @ are permitted.`,
    );
  }
  if (value.startsWith("-")) {
    throw new Error(`Invalid ${label}: must not start with a dash`);
  }
  return value;
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
  const safeOwner = sanitizeGitArg(owner, "repository owner");
  const safeRepo = sanitizeGitArg(repo, "repository name");
  const repoUrl = `https://github.com/${safeOwner}/${safeRepo}.git`;
  try {
    // git ls-remote --symref outputs:
    // ref: refs/heads/main    HEAD
    // a1b2c3d...              HEAD
    const { stdout } = await execFileAsync("git", [
      "ls-remote",
      "--symref",
      repoUrl,
      "HEAD",
    ]);

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

  const safeOwner = sanitizeGitArg(parsed.owner, "repository owner");
  const safeRepo = sanitizeGitArg(parsed.repo, "repository name");
  const repoUrl = `https://github.com/${safeOwner}/${safeRepo}.git`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vm0-github-"));

  try {
    // Check git is available
    try {
      await execFileAsync("git", ["--version"]);
    } catch {
      throw new Error(
        "git command not found. Please install git to use GitHub URLs.",
      );
    }

    // Resolve branch if not specified
    const branch = sanitizeGitArg(
      parsed.branch ?? (await getDefaultBranch(safeOwner, safeRepo)),
      "branch name",
    );

    // Initialize sparse checkout
    await execFileAsync("git", ["init"], { cwd: tempDir });
    await execFileAsync("git", ["remote", "add", "origin", repoUrl], {
      cwd: tempDir,
    });
    await execFileAsync("git", ["config", "core.sparseCheckout", "true"], {
      cwd: tempDir,
    });

    // Configure sparse checkout pattern
    // For root: use "/*" to get all root-level files
    // For path: use the path directly
    const sparsePattern = parsed.path ?? "/*";
    const sparseFile = path.join(tempDir, ".git", "info", "sparse-checkout");
    await fs.writeFile(sparseFile, sparsePattern + "\n");

    // Fetch only the required branch with better error handling
    try {
      await execFileAsync("git", ["fetch", "--depth", "1", "origin", branch], {
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

    await execFileAsync("git", ["checkout", branch], { cwd: tempDir });

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
