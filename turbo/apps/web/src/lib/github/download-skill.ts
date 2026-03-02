/**
 * Download skill files from a GitHub repository using the GitHub Contents API
 * and raw.githubusercontent.com.
 *
 * Works in Vercel serverless environments (no git binary required).
 */

import type { ParsedGitHubTreeUrl } from "@vm0/core";
import { env } from "../../env";

/**
 * A downloaded file from GitHub.
 */
interface DownloadedFile {
  /** Relative path within the skill directory */
  path: string;
  /** File content */
  content: Buffer;
}

/**
 * GitHub Contents API response entry.
 */
interface GitHubContentsEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
}

/**
 * Download all files from a GitHub skill directory.
 *
 * Uses the GitHub Contents API to list files, then fetches each file's
 * content from raw.githubusercontent.com. Validates that SKILL.md exists
 * in the directory.
 *
 * @param parsed - Parsed GitHub tree URL components
 * @returns Array of downloaded files with relative paths and content
 * @throws If the directory cannot be listed or SKILL.md is missing
 */
export async function downloadSkillFromGitHub(
  parsed: ParsedGitHubTreeUrl,
): Promise<DownloadedFile[]> {
  const entries = await listDirectoryRecursive(
    parsed.owner,
    parsed.repo,
    parsed.branch,
    parsed.path,
    parsed.path,
  );

  if (!entries.some((e) => e.path === "SKILL.md")) {
    throw new Error(
      `SKILL.md not found in ${parsed.owner}/${parsed.repo}/${parsed.path}`,
    );
  }

  // Download all files in parallel
  const files = await Promise.all(
    entries.map(async (entry) => {
      const url = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.branch}/${entry.fullPath}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `Failed to download ${entry.fullPath}: ${res.status} ${res.statusText}`,
        );
      }
      const content = Buffer.from(await res.arrayBuffer());
      return { path: entry.path, content };
    }),
  );

  return files;
}

/**
 * Internal entry tracking both the relative path (within skill dir)
 * and the full repo path (for download URL construction).
 */
interface FileEntry {
  path: string;
  fullPath: string;
}

/**
 * Recursively list all files in a GitHub directory via the Contents API.
 */
async function listDirectoryRecursive(
  owner: string,
  repo: string,
  branch: string,
  dirPath: string,
  rootPath: string,
): Promise<FileEntry[]> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  const token = env().GITHUB_SKILL_DOWNLOAD_TOKEN;
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  const res = await fetch(apiUrl, { headers });

  if (!res.ok) {
    throw new Error(
      `GitHub API error listing ${dirPath}: ${res.status} ${res.statusText}`,
    );
  }

  const items: GitHubContentsEntry[] = await res.json();
  const results: FileEntry[] = [];

  for (const item of items) {
    if (item.type === "file") {
      // Compute path relative to the skill root directory
      const relativePath = item.path.startsWith(rootPath + "/")
        ? item.path.slice(rootPath.length + 1)
        : item.path;
      results.push({ path: relativePath, fullPath: item.path });
    } else if (item.type === "dir") {
      const subEntries = await listDirectoryRecursive(
        owner,
        repo,
        branch,
        item.path,
        rootPath,
      );
      results.push(...subEntries);
    }
  }

  return results;
}
