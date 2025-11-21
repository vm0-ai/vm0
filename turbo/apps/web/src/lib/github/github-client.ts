import fs from "fs/promises";
import path from "path";
import { decryptToken, isEncryptedToken } from "../crypto/token-encryption";
import type { DownloadResult, GitHubUri, UploadResult } from "./types";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import tar from "tar";

/**
 * Parse GitHub URI
 * Format: github://owner/repo/path@ref or github://owner/repo@ref
 */
export function parseGitHubUri(uri: string): GitHubUri {
  const pattern = /^github:\/\/([^/]+)\/([^/@]+)(?:\/([^@]*))?(?:@(.+))?$/;
  const match = uri.match(pattern);

  if (!match) {
    throw new Error(`Invalid GitHub URI: ${uri}`);
  }

  return {
    owner: match[1]!,
    repo: match[2]!,
    path: match[3] || "",
    ref: match[4] || "main",
  };
}

/**
 * Get directory statistics
 */
async function getDirectoryStats(dirPath: string): Promise<{
  fileCount: number;
  totalBytes: number;
}> {
  let fileCount = 0;
  let totalBytes = 0;

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        fileCount++;
        const stat = await fs.stat(fullPath);
        totalBytes += stat.size;
      }
    }
  };

  await walk(dirPath);
  return { fileCount, totalBytes };
}

/**
 * Download repository contents using GitHub API (tarball)
 */
export async function downloadGitHubDirectory(
  githubUri: string,
  localPath: string,
  token: string,
  userId: string,
  encryptionSecret: string,
): Promise<DownloadResult> {
  const { owner, repo, ref } = parseGitHubUri(githubUri);

  const actualToken = isEncryptedToken(token)
    ? decryptToken(token, userId, encryptionSecret)
    : token;

  await fs.mkdir(localPath, { recursive: true });

  try {
    // Download tarball from GitHub API
    const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${ref}`;
    const response = await fetch(tarballUrl, {
      headers: {
        Authorization: `Bearer ${actualToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download repository: ${response.status} ${response.statusText}`,
      );
    }

    // Get commit SHA from response headers
    const contentDisposition = response.headers.get("content-disposition");
    const commitShaMatch = contentDisposition?.match(/filename=.*-([a-f0-9]{7,40})\.tar\.gz/);
    const commitSha = commitShaMatch?.[1] || "unknown";

    // Extract tarball to local path
    if (!response.body) {
      throw new Error("Response body is null");
    }

    // Convert Web ReadableStream to Node.js Readable
    const nodeStream = Readable.fromWeb(response.body as any);

    // Extract tar.gz - GitHub tarballs have a root directory we need to strip
    await pipeline(
      nodeStream,
      tar.extract({
        cwd: localPath,
        strip: 1, // Remove the root directory from the tarball
      }),
    );

    const stats = await getDirectoryStats(localPath);

    return {
      filesDownloaded: stats.fileCount,
      bytesDownloaded: stats.totalBytes,
      commitSha,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to download GitHub repository: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Upload directory as new commit on specific branch using GitHub API
 * TODO: Implement using GitHub Tree API for MVP phase
 */
export async function uploadGitHubDirectory(
  localPath: string,
  githubUri: string,
  branch: string,
  commitMessage: string,
  token: string,
  userId: string,
  encryptionSecret: string,
): Promise<UploadResult> {
  // For MVP, we disable upload functionality
  // This will be implemented using GitHub Git Data API (create tree + commit)
  throw new Error(
    "GitHub volume upload is not yet implemented. Read-only support is available.",
  );

  // const { owner, repo } = parseGitHubUri(githubUri);
  // const actualToken = isEncryptedToken(token)
  //   ? decryptToken(token, userId, encryptionSecret)
  //   : token;

  // TODO: Implement using GitHub API:
  // 1. Get current ref SHA
  // 2. Create blobs for all files
  // 3. Create tree
  // 4. Create commit
  // 5. Update ref
}
