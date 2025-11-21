import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { decryptToken, isEncryptedToken } from "../crypto/token-encryption";
import type { DownloadResult, GitHubUri, UploadResult } from "./types";

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
 * Download repository contents using git clone
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

  const cloneUrl = `https://${actualToken}@github.com/${owner}/${repo}.git`;

  await fs.mkdir(localPath, { recursive: true });

  try {
    execSync(`git clone --depth 1 --branch ${ref} ${cloneUrl} ${localPath}`, {
      stdio: "pipe",
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to clone GitHub repository: ${error.message}`);
    }
    throw error;
  }

  const commitSha = execSync("git rev-parse HEAD", {
    cwd: localPath,
    encoding: "utf8",
  }).trim();

  await fs.rm(path.join(localPath, ".git"), { recursive: true, force: true });

  const stats = await getDirectoryStats(localPath);

  return {
    filesDownloaded: stats.fileCount,
    bytesDownloaded: stats.totalBytes,
    commitSha,
  };
}

/**
 * Upload directory as new commit on specific branch
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
  const { owner, repo } = parseGitHubUri(githubUri);

  const actualToken = isEncryptedToken(token)
    ? decryptToken(token, userId, encryptionSecret)
    : token;

  const remoteUrl = `https://${actualToken}@github.com/${owner}/${repo}.git`;

  try {
    execSync("git init", { cwd: localPath, stdio: "pipe" });
    execSync(`git remote add origin ${remoteUrl}`, {
      cwd: localPath,
      stdio: "pipe",
    });
    execSync('git config user.name "VM0 Agent"', {
      cwd: localPath,
      stdio: "pipe",
    });
    execSync('git config user.email "agent@vm0.ai"', {
      cwd: localPath,
      stdio: "pipe",
    });

    execSync("git fetch origin main", { cwd: localPath, stdio: "pipe" });
    execSync(`git checkout -b ${branch} origin/main`, {
      cwd: localPath,
      stdio: "pipe",
    });

    execSync("git add .", { cwd: localPath, stdio: "pipe" });
    execSync(`git commit -m "${commitMessage}"`, {
      cwd: localPath,
      stdio: "pipe",
    });
    execSync(`git push origin ${branch}`, { cwd: localPath, stdio: "pipe" });

    const commitSha = execSync("git rev-parse HEAD", {
      cwd: localPath,
      encoding: "utf8",
    }).trim();

    const stats = await getDirectoryStats(localPath);

    return {
      commitSha,
      branch,
      filesUploaded: stats.fileCount,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to upload to GitHub repository: ${error.message}`,
      );
    }
    throw error;
  }
}
