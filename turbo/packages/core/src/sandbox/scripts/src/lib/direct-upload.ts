/**
 * Direct S3 upload module for VAS (Versioned Artifact Storage).
 * Bypasses Vercel's 4.5MB request body limit by uploading directly to S3.
 *
 * Flow:
 * 1. Compute file hashes locally
 * 2. Call /api/storages/prepare to get presigned URLs
 * 3. Upload archive and manifest directly to S3
 * 4. Call /api/storages/commit to finalize
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { STORAGE_PREPARE_URL, STORAGE_COMMIT_URL } from "./common.js";
import { logInfo, logWarn, logError } from "./log.js";
import { httpPostJson, httpPutPresigned } from "./http-client.js";

interface FileEntry {
  path: string;
  hash: string;
  size: number;
}

interface UploadInfo {
  presignedUrl: string;
}

interface PrepareResponse {
  versionId: string;
  existing?: boolean;
  uploads?: {
    archive: UploadInfo;
    manifest: UploadInfo;
  };
}

/**
 * Compute SHA-256 hash for a file.
 */
export function computeFileHash(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const content = fs.readFileSync(filePath);
  hash.update(content);
  return hash.digest("hex");
}

/**
 * Collect file metadata with hashes for a directory.
 *
 * @param dirPath - Directory to scan
 * @returns List of file entries: [{path, hash, size}, ...]
 */
export function collectFileMetadata(dirPath: string): FileEntry[] {
  const files: FileEntry[] = [];
  const originalDir = process.cwd();

  try {
    process.chdir(dirPath);

    const walkDir = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        // Exclude .git and .vm0 directories
        if (entry.isDirectory()) {
          if (entry.name !== ".git" && entry.name !== ".vm0") {
            walkDir(path.join(dir, entry.name));
          }
          continue;
        }

        if (entry.isFile()) {
          let relPath = path.join(dir, entry.name);
          // Remove leading ./
          if (relPath.startsWith("./")) {
            relPath = relPath.slice(2);
          }

          const fullPath = path.join(dirPath, relPath);
          try {
            const fileHash = computeFileHash(fullPath);
            const fileSize = fs.statSync(fullPath).size;
            files.push({
              path: relPath,
              hash: fileHash,
              size: fileSize,
            });
          } catch (err) {
            logWarn(`Could not process file ${relPath}: ${err}`);
          }
        }
      }
    };

    walkDir(".");
  } finally {
    process.chdir(originalDir);
  }

  return files;
}

/**
 * Create tar.gz archive of directory contents.
 *
 * @param dirPath - Source directory
 * @param tarPath - Destination tar.gz path
 * @returns true on success, false on failure
 */
export function createArchive(dirPath: string, tarPath: string): boolean {
  const originalDir = process.cwd();

  try {
    process.chdir(dirPath);

    // Get items to archive (exclude .git and .vm0)
    const items = fs
      .readdirSync(".")
      .filter((item) => item !== ".git" && item !== ".vm0");

    if (items.length === 0) {
      // Create empty archive
      execSync(`tar czf "${tarPath}" --files-from /dev/null`, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // Create archive with items
      const itemsStr = items.map((i) => `"${i}"`).join(" ");
      execSync(`tar czf "${tarPath}" ${itemsStr}`, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: "/bin/bash",
      });
    }

    return true;
  } catch (err) {
    logError(`Failed to create archive: ${err}`);
    return false;
  } finally {
    process.chdir(originalDir);
  }
}

/**
 * Create manifest JSON file.
 *
 * @param files - List of file entries
 * @param manifestPath - Destination path for manifest
 * @returns true on success, false on failure
 */
export function createManifest(
  files: FileEntry[],
  manifestPath: string,
): boolean {
  try {
    const manifest = {
      version: 1,
      files,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return true;
  } catch (err) {
    logError(`Failed to create manifest: ${err}`);
    return false;
  }
}

/**
 * Create VAS snapshot using direct S3 upload.
 * Bypasses Vercel's 4.5MB request body limit.
 *
 * @param mountPath - Path to the storage directory
 * @param storageName - VAS storage name
 * @param storageType - Storage type ("volume" or "artifact")
 * @param runId - Optional run ID for sandbox auth
 * @param message - Optional commit message
 * @returns Object with versionId on success, null on failure
 */
export async function createDirectUploadSnapshot(
  mountPath: string,
  storageName: string,
  storageType: string = "artifact",
  runId?: string,
  message?: string,
): Promise<{ versionId: string; deduplicated?: boolean } | null> {
  logInfo(
    `Creating direct upload snapshot for '${storageName}' (type: ${storageType})`,
  );

  // Step 1: Collect file metadata
  logInfo("Computing file hashes...");
  const files = collectFileMetadata(mountPath);
  logInfo(`Found ${files.length} files`);

  if (files.length === 0) {
    logInfo("No files to upload, creating empty version");
  }

  // Step 2: Call prepare endpoint
  logInfo("Calling prepare endpoint...");
  const preparePayload: Record<string, unknown> = {
    storageName,
    storageType,
    files,
  };
  if (runId) {
    preparePayload.runId = runId;
  }

  const prepareResponse = (await httpPostJson(
    STORAGE_PREPARE_URL,
    preparePayload,
  )) as PrepareResponse | null;
  if (!prepareResponse) {
    logError("Failed to call prepare endpoint");
    return null;
  }

  const versionId = prepareResponse.versionId;
  if (!versionId) {
    logError(`Invalid prepare response: ${JSON.stringify(prepareResponse)}`);
    return null;
  }

  // Step 3: Check if version already exists (deduplication)
  // Still call commit to update HEAD pointer (fixes #649)
  if (prepareResponse.existing) {
    logInfo(`Version already exists (deduplicated): ${versionId.slice(0, 8)}`);
    logInfo("Updating HEAD pointer...");

    const commitPayload: Record<string, unknown> = {
      storageName,
      storageType,
      versionId,
      files,
    };
    if (runId) {
      commitPayload.runId = runId;
    }

    const commitResponse = await httpPostJson(
      STORAGE_COMMIT_URL,
      commitPayload,
    );
    if (!commitResponse || !commitResponse.success) {
      logError(`Failed to update HEAD: ${JSON.stringify(commitResponse)}`);
      return null;
    }

    return { versionId, deduplicated: true };
  }

  // Step 4: Get presigned URLs
  const uploads = prepareResponse.uploads;
  if (!uploads) {
    logError("No upload URLs in prepare response");
    return null;
  }

  const archiveInfo = uploads.archive;
  const manifestInfo = uploads.manifest;

  if (!archiveInfo || !manifestInfo) {
    logError("Missing archive or manifest upload info");
    return null;
  }

  // Step 5: Create and upload files
  const tempDir = `/tmp/direct-upload-${storageName}-${Date.now()}`;
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Create archive
    logInfo("Creating archive...");
    const archivePath = path.join(tempDir, "archive.tar.gz");
    if (!createArchive(mountPath, archivePath)) {
      logError("Failed to create archive");
      return null;
    }

    // Create manifest
    logInfo("Creating manifest...");
    const manifestPath = path.join(tempDir, "manifest.json");
    if (!createManifest(files, manifestPath)) {
      logError("Failed to create manifest");
      return null;
    }

    // Upload archive to S3
    logInfo("Uploading archive to S3...");
    if (
      !httpPutPresigned(
        archiveInfo.presignedUrl,
        archivePath,
        "application/gzip",
      )
    ) {
      logError("Failed to upload archive to S3");
      return null;
    }

    // Upload manifest to S3
    logInfo("Uploading manifest to S3...");
    if (
      !httpPutPresigned(
        manifestInfo.presignedUrl,
        manifestPath,
        "application/json",
      )
    ) {
      logError("Failed to upload manifest to S3");
      return null;
    }

    // Step 6: Call commit endpoint
    logInfo("Calling commit endpoint...");
    const commitPayload: Record<string, unknown> = {
      storageName,
      storageType,
      versionId,
      files,
    };
    if (runId) {
      commitPayload.runId = runId;
    }
    if (message) {
      commitPayload.message = message;
    }

    const commitResponse = await httpPostJson(
      STORAGE_COMMIT_URL,
      commitPayload,
    );
    if (!commitResponse) {
      logError("Failed to call commit endpoint");
      return null;
    }

    if (!commitResponse.success) {
      logError(`Commit failed: ${JSON.stringify(commitResponse)}`);
      return null;
    }

    logInfo(`Direct upload snapshot created: ${versionId.slice(0, 8)}`);
    return { versionId };
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
