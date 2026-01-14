import chalk from "chalk";
import path from "path";
import * as fs from "fs";
import * as os from "os";
import * as tar from "tar";
import { writeStorageConfig, type StorageType } from "./storage-utils";
import { apiClient, type ApiError } from "../api/api-client";
import { listTarFiles, formatBytes } from "../utils/file-utils";

/**
 * Download response from /api/storages/download
 */
interface DownloadResponse {
  url?: string;
  empty?: boolean;
  versionId: string;
  fileCount: number;
  size: number;
}

export interface CloneOptions {
  version?: string;
}

export interface CloneResult {
  success: boolean;
  fileCount: number;
  size: number;
  versionId: string;
}

/**
 * Clone a remote storage to a local directory
 * Creates the directory, downloads contents, and initializes .vm0 config
 */
export async function cloneStorage(
  name: string,
  type: StorageType,
  destination: string,
  options: CloneOptions = {},
): Promise<CloneResult> {
  const typeLabel = type === "artifact" ? "artifact" : "volume";

  // Check if destination already exists
  if (fs.existsSync(destination)) {
    throw new Error(`Directory "${destination}" already exists`);
  }

  // Check if storage exists on remote
  console.log(chalk.dim(`Checking remote ${typeLabel}...`));

  let url = `/api/storages/download?name=${encodeURIComponent(name)}&type=${type}`;
  if (options.version) {
    // Quote version as JSON string to prevent ts-rest's jsonQuery from
    // parsing hex strings like "52999e37" as scientific notation numbers
    const quotedVersion = JSON.stringify(options.version);
    url += `&version=${encodeURIComponent(quotedVersion)}`;
  }

  const response = await apiClient.get(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} "${name}" not found`,
      );
    }
    const error = (await response.json()) as ApiError;
    throw new Error(error.error?.message || "Clone failed");
  }

  const downloadInfo = (await response.json()) as DownloadResponse;

  // Create destination directory
  console.log(chalk.dim(`Creating directory: ${destination}/`));
  await fs.promises.mkdir(destination, { recursive: true });

  // Handle empty storage
  if (downloadInfo.empty) {
    // Create .vm0 directory and config
    await writeStorageConfig(name, destination, type);

    console.log(chalk.green(`✓ Cloned empty ${typeLabel}: ${name}`));
    console.log(chalk.dim(`✓ Initialized .vm0/storage.yaml`));

    return {
      success: true,
      fileCount: 0,
      size: 0,
      versionId: downloadInfo.versionId,
    };
  }

  if (!downloadInfo.url) {
    throw new Error("No download URL returned");
  }

  // Download from S3
  console.log(chalk.dim("Downloading from S3..."));
  const s3Response = await fetch(downloadInfo.url);

  if (!s3Response.ok) {
    // Clean up directory on failure
    await fs.promises.rm(destination, { recursive: true, force: true });
    throw new Error(`S3 download failed: ${s3Response.status}`);
  }

  // Get tar.gz buffer
  const arrayBuffer = await s3Response.arrayBuffer();
  const tarBuffer = Buffer.from(arrayBuffer);

  console.log(chalk.green(`✓ Downloaded ${formatBytes(tarBuffer.length)}`));

  // Save tar.gz to temp file for processing
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm0-clone-"));
  const tarPath = path.join(tmpDir, "archive.tar.gz");
  await fs.promises.writeFile(tarPath, tarBuffer);

  // Get file list from tar
  const files = await listTarFiles(tarPath);

  // Extract tar.gz to destination
  console.log(chalk.dim("Extracting files..."));
  await tar.extract({
    file: tarPath,
    cwd: destination,
    gzip: true,
  });

  // Clean up temp files
  await fs.promises.unlink(tarPath);
  await fs.promises.rmdir(tmpDir);

  console.log(chalk.green(`✓ Extracted ${files.length} files`));

  // Create .vm0 directory and config
  await writeStorageConfig(name, destination, type);
  console.log(chalk.green(`✓ Initialized .vm0/storage.yaml`));

  return {
    success: true,
    fileCount: downloadInfo.fileCount,
    size: downloadInfo.size,
    versionId: downloadInfo.versionId,
  };
}
