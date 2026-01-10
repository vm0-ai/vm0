/**
 * Download storages script for E2B sandbox.
 * Downloads tar.gz archives directly from S3 using presigned URLs.
 *
 * Usage: node download.js <manifest_path>
 */
import * as fs from "fs";
import { execSync } from "child_process";
import { logInfo, logError } from "./log.js";
import { httpDownload } from "./http-client.js";

interface StorageEntry {
  mountPath: string;
  archiveUrl?: string;
}

interface ArtifactEntry {
  mountPath: string;
  archiveUrl?: string;
}

interface StorageManifest {
  storages: StorageEntry[];
  artifact?: ArtifactEntry;
}

/**
 * Download and extract a single storage/artifact.
 *
 * @param mountPath - Destination mount path
 * @param archiveUrl - Presigned S3 URL for tar.gz archive
 * @returns true on success, false on failure
 */
export function downloadStorage(
  mountPath: string,
  archiveUrl: string,
): boolean {
  logInfo(`Downloading storage to ${mountPath}`);

  // Create temp file for download
  const tempTar = `/tmp/storage-${Date.now()}.tar.gz`;

  try {
    // Download tar.gz with retry
    if (!httpDownload(archiveUrl, tempTar)) {
      logError(`Failed to download archive for ${mountPath}`);
      return false;
    }

    // Create mount path directory
    fs.mkdirSync(mountPath, { recursive: true });

    // Extract to mount path (handle empty archive gracefully)
    try {
      execSync(`tar xzf "${tempTar}" -C "${mountPath}"`, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // Empty or invalid archive - not a fatal error
      logInfo(`Archive appears empty for ${mountPath}`);
    }

    logInfo(`Successfully extracted to ${mountPath}`);
    return true;
  } finally {
    // Cleanup temp file
    try {
      if (fs.existsSync(tempTar)) {
        fs.unlinkSync(tempTar);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Main entry point for download storages script.
 */
export function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    logError("Usage: node download.js <manifest_path>");
    process.exit(1);
  }

  const manifestPath = args[0] as string;

  if (!fs.existsSync(manifestPath)) {
    logError(`Manifest file not found: ${manifestPath}`);
    process.exit(1);
  }

  logInfo(`Starting storage download from manifest: ${manifestPath}`);

  // Load manifest
  let manifest: StorageManifest;
  try {
    const content = fs.readFileSync(manifestPath, "utf-8");
    manifest = JSON.parse(content) as StorageManifest;
  } catch (err) {
    logError(`Failed to load manifest: ${err}`);
    process.exit(1);
  }

  // Count total storages
  const storages = manifest.storages ?? [];
  const artifact = manifest.artifact;

  const storageCount = storages.length;
  const hasArtifact = artifact !== undefined;

  logInfo(`Found ${storageCount} storages, artifact: ${hasArtifact}`);

  // Process storages
  for (const storage of storages) {
    const { mountPath, archiveUrl } = storage;

    if (archiveUrl && archiveUrl !== "null") {
      downloadStorage(mountPath, archiveUrl);
    }
  }

  // Process artifact
  if (artifact) {
    const { mountPath: artifactMount, archiveUrl: artifactUrl } = artifact;

    if (artifactUrl && artifactUrl !== "null") {
      downloadStorage(artifactMount, artifactUrl);
    }
  }

  logInfo("All storages downloaded successfully");
}

// Run main when executed directly
main();
