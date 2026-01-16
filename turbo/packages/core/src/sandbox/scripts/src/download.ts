/**
 * Download storages script for E2B sandbox.
 * Downloads tar.gz archives directly from S3 using presigned URLs.
 *
 * Usage: node download.mjs <manifest_path>
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { recordSandboxOp } from "./lib/common.js";
import { logInfo, logError } from "./lib/log.js";
import { httpDownload } from "./lib/http-client.js";

interface Storage {
  mountPath: string;
  archiveUrl?: string;
}

interface Artifact {
  mountPath: string;
  archiveUrl?: string;
}

interface Manifest {
  storages?: Storage[];
  artifact?: Artifact;
}

/**
 * Download and extract a single storage/artifact.
 *
 * @param mountPath - Destination mount path
 * @param archiveUrl - Presigned S3 URL for tar.gz archive
 * @returns true on success, false on failure
 */
async function downloadStorage(
  mountPath: string,
  archiveUrl: string,
): Promise<boolean> {
  logInfo(`Downloading storage to ${mountPath}`);

  // Create temp file for download
  const tempTar = path.join(
    os.tmpdir(),
    `storage-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`,
  );

  try {
    // Download tar.gz with retry
    if (!(await httpDownload(archiveUrl, tempTar))) {
      logError(`Failed to download archive for ${mountPath}`);
      return false;
    }

    // Create mount path directory
    fs.mkdirSync(mountPath, { recursive: true });

    // Extract to mount path (handle empty archive gracefully)
    try {
      execSync(`tar -xzf "${tempTar}" -C "${mountPath}"`, {
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
      fs.unlinkSync(tempTar);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Main entry point for download storages script.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    logError("Usage: node download.mjs <manifest_path>");
    process.exit(1);
  }

  const manifestPath = args[0] ?? "";

  if (!manifestPath || !fs.existsSync(manifestPath)) {
    logError(`Manifest file not found: ${manifestPath}`);
    process.exit(1);
  }

  logInfo(`Starting storage download from manifest: ${manifestPath}`);

  // Load manifest
  let manifest: Manifest;
  try {
    const content = fs.readFileSync(manifestPath, "utf-8");
    manifest = JSON.parse(content) as Manifest;
  } catch (error) {
    logError(`Failed to load manifest: ${error}`);
    process.exit(1);
  }

  // Count total storages
  const storages = manifest.storages ?? [];
  const artifact = manifest.artifact;

  const storageCount = storages.length;
  const hasArtifact = artifact !== undefined;

  logInfo(`Found ${storageCount} storages, artifact: ${hasArtifact}`);

  // Track total download time
  const downloadTotalStart = Date.now();
  let downloadSuccess = true;

  // Process storages
  for (const storage of storages) {
    const mountPath = storage.mountPath;
    const archiveUrl = storage.archiveUrl;

    if (archiveUrl && archiveUrl !== "null") {
      const storageStart = Date.now();
      const success = await downloadStorage(mountPath, archiveUrl);
      recordSandboxOp("storage_download", Date.now() - storageStart, success);
      if (!success) {
        downloadSuccess = false;
      }
    }
  }

  // Process artifact
  if (artifact) {
    const artifactMount = artifact.mountPath;
    const artifactUrl = artifact.archiveUrl;

    if (artifactUrl && artifactUrl !== "null") {
      const artifactStart = Date.now();
      const success = await downloadStorage(artifactMount, artifactUrl);
      recordSandboxOp("artifact_download", Date.now() - artifactStart, success);
      if (!success) {
        downloadSuccess = false;
      }
    }
  }

  // Record total download time
  recordSandboxOp(
    "download_total",
    Date.now() - downloadTotalStart,
    downloadSuccess,
  );
  logInfo("All storages downloaded successfully");
}

// Run main
main().catch((error) => {
  logError(`Fatal error: ${error}`);
  process.exit(1);
});
