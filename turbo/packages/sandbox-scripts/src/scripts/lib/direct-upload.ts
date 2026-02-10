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
import {
  STORAGE_PREPARE_URL,
  STORAGE_COMMIT_URL,
  recordSandboxOp,
} from "./common.js";
import { logInfo, logWarn, logError } from "./log.js";
import { httpPostJson, httpPutPresigned } from "./http-client.js";

interface FileEntry {
  path: string;
  hash: string;
  size: number;
}

interface PrepareResponse {
  versionId?: string;
  existing?: boolean;
  uploads?: {
    archive?: { presignedUrl: string };
    manifest?: { presignedUrl: string };
  };
}

interface CommitResponse {
  success?: boolean;
}

interface SnapshotResult {
  versionId: string;
  deduplicated?: boolean;
}

/**
 * Compute SHA-256 hash for a file.
 */
export function computeFileHash(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
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

  function walkDir(currentPath: string, relativePath: string): void {
    const items = fs.readdirSync(currentPath);

    for (const item of items) {
      // Exclude .git and .vm0 directories
      if (item === ".git" || item === ".vm0") {
        continue;
      }

      const fullPath = path.join(currentPath, item);
      const relPath = relativePath ? path.join(relativePath, item) : item;
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (stat.isFile()) {
        try {
          const fileHash = computeFileHash(fullPath);
          files.push({
            path: relPath,
            hash: fileHash,
            size: stat.size,
          });
        } catch (error) {
          logWarn(`Could not process file ${relPath}: ${error}`);
        }
      }
    }
  }

  walkDir(dirPath, "");
  return files;
}

/**
 * Create tar.gz archive of directory contents.
 * Uses shell tar command for reliability.
 *
 * @param dirPath - Source directory
 * @param tarPath - Destination tar.gz path
 * @returns true on success, false on failure
 */
export function createArchive(dirPath: string, tarPath: string): boolean {
  try {
    // Use tar command with exclusions
    // --exclude patterns before the directory
    execSync(
      `tar -czf "${tarPath}" --exclude='.git' --exclude='.vm0' -C "${dirPath}" .`,
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch (error) {
    logError(`Failed to create archive: ${error}`);
    return false;
  }
}

interface Manifest {
  version: number;
  files: FileEntry[];
  createdAt: string;
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
    const manifest: Manifest = {
      version: 1,
      files,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return true;
  } catch (error) {
    logError(`Failed to create manifest: ${error}`);
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
// eslint-disable-next-line complexity -- TODO: refactor complex function
export async function createDirectUploadSnapshot(
  mountPath: string,
  storageName: string,
  storageType: string = "artifact",
  runId?: string,
  message?: string,
): Promise<SnapshotResult | null> {
  logInfo(
    `Creating direct upload snapshot for '${storageName}' (type: ${storageType})`,
  );

  // Step 1: Collect file metadata
  logInfo("Computing file hashes...");
  const hashStart = Date.now();
  const files = collectFileMetadata(mountPath);
  recordSandboxOp("artifact_hash_compute", Date.now() - hashStart, true);
  logInfo(`Found ${files.length} files`);

  if (files.length === 0) {
    logInfo("No files to upload, creating empty version");
  }

  // Step 2: Call prepare endpoint
  logInfo("Calling prepare endpoint...");
  const prepareStart = Date.now();
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
    recordSandboxOp("artifact_prepare_api", Date.now() - prepareStart, false);
    return null;
  }

  const versionId = prepareResponse.versionId;
  if (!versionId) {
    logError(`Invalid prepare response: ${JSON.stringify(prepareResponse)}`);
    recordSandboxOp("artifact_prepare_api", Date.now() - prepareStart, false);
    return null;
  }
  recordSandboxOp("artifact_prepare_api", Date.now() - prepareStart, true);

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

    const commitResponse = (await httpPostJson(
      STORAGE_COMMIT_URL,
      commitPayload,
    )) as CommitResponse | null;
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
  const tempDir = fs.mkdtempSync(`/tmp/direct-upload-${storageName}-`);

  try {
    // Create archive
    logInfo("Creating archive...");
    const archiveStart = Date.now();
    const archivePath = path.join(tempDir, "archive.tar.gz");
    if (!createArchive(mountPath, archivePath)) {
      logError("Failed to create archive");
      recordSandboxOp(
        "artifact_archive_create",
        Date.now() - archiveStart,
        false,
      );
      return null;
    }
    recordSandboxOp("artifact_archive_create", Date.now() - archiveStart, true);

    // Create manifest
    logInfo("Creating manifest...");
    const manifestPath = path.join(tempDir, "manifest.json");
    if (!createManifest(files, manifestPath)) {
      logError("Failed to create manifest");
      return null;
    }

    // Upload archive to S3
    logInfo("Uploading archive to S3...");
    const s3UploadStart = Date.now();
    if (
      !(await httpPutPresigned(
        archiveInfo.presignedUrl,
        archivePath,
        "application/gzip",
      ))
    ) {
      logError("Failed to upload archive to S3");
      recordSandboxOp("artifact_s3_upload", Date.now() - s3UploadStart, false);
      return null;
    }

    // Upload manifest to S3
    logInfo("Uploading manifest to S3...");
    if (
      !(await httpPutPresigned(
        manifestInfo.presignedUrl,
        manifestPath,
        "application/json",
      ))
    ) {
      logError("Failed to upload manifest to S3");
      recordSandboxOp("artifact_s3_upload", Date.now() - s3UploadStart, false);
      return null;
    }
    recordSandboxOp("artifact_s3_upload", Date.now() - s3UploadStart, true);

    // Step 6: Call commit endpoint
    logInfo("Calling commit endpoint...");
    const commitStart = Date.now();
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

    const commitResponse = (await httpPostJson(
      STORAGE_COMMIT_URL,
      commitPayload,
    )) as CommitResponse | null;
    if (!commitResponse) {
      logError("Failed to call commit endpoint");
      recordSandboxOp("artifact_commit_api", Date.now() - commitStart, false);
      return null;
    }

    if (!commitResponse.success) {
      logError(`Commit failed: ${JSON.stringify(commitResponse)}`);
      recordSandboxOp("artifact_commit_api", Date.now() - commitStart, false);
      return null;
    }
    recordSandboxOp("artifact_commit_api", Date.now() - commitStart, true);

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
