import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as tar from "tar";
import { prepareStorage, commitStorage } from "../api";
import { excludeVm0Filter } from "../utils/file-utils";

/**
 * File entry with pre-computed hash for direct upload
 */
interface FileEntryWithHash {
  path: string;
  hash: string;
  size: number;
}

/**
 * Result of direct upload operation
 */
interface DirectUploadResult {
  versionId: string;
  size: number;
  fileCount: number;
  deduplicated: boolean;
  empty: boolean;
}

/**
 * Progress callback for upload operations
 */
type ProgressCallback = (message: string) => void;

/**
 * Compute SHA-256 hash of a file using streaming to avoid loading large files into memory
 */
async function hashFileStream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Get all files in directory recursively, excluding .vm0/
 */
async function getAllFiles(
  dirPath: string,
  baseDir: string = dirPath,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    // Skip .vm0 directory
    if (relativePath.startsWith(".vm0")) {
      continue;
    }

    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath, baseDir);
      files.push(...subFiles);
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Collect file metadata with hashes using streaming to handle large files
 */
async function collectFileMetadata(
  cwd: string,
  files: string[],
  onProgress?: ProgressCallback,
): Promise<FileEntryWithHash[]> {
  const fileEntries: FileEntryWithHash[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const relativePath = path.relative(cwd, file);

    // Use streaming hash to avoid loading large files into memory
    const [hash, stats] = await Promise.all([
      hashFileStream(file),
      fs.promises.stat(file),
    ]);

    fileEntries.push({
      path: relativePath,
      hash,
      size: stats.size,
    });

    // Report progress every 100 files
    if (onProgress && (i + 1) % 100 === 0) {
      onProgress(`Hashing files... ${i + 1}/${files.length}`);
    }
  }

  return fileEntries;
}

/**
 * Create tar.gz archive of files
 */
async function createArchive(cwd: string, files: string[]): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm0-"));
  const tarPath = path.join(tmpDir, "archive.tar.gz");

  try {
    const relativePaths = files.map((file) => path.relative(cwd, file));

    if (relativePaths.length > 0) {
      await tar.create(
        {
          gzip: true,
          file: tarPath,
          cwd: cwd,
        },
        relativePaths,
      );
    } else {
      // For empty directories, create tar.gz excluding .vm0
      await tar.create(
        {
          gzip: true,
          file: tarPath,
          cwd: cwd,
          filter: excludeVm0Filter,
        },
        ["."],
      );
    }

    const tarBuffer = await fs.promises.readFile(tarPath);
    return tarBuffer;
  } finally {
    // Clean up temp files
    if (fs.existsSync(tarPath)) {
      await fs.promises.unlink(tarPath);
    }
    await fs.promises.rmdir(tmpDir);
  }
}

/**
 * Create manifest JSON for the upload
 */
function createManifest(files: FileEntryWithHash[]): Buffer {
  const manifest = {
    version: 1,
    files,
    createdAt: new Date().toISOString(),
  };
  return Buffer.from(JSON.stringify(manifest, null, 2));
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Upload buffer to presigned URL with retry logic
 */
async function uploadToPresignedUrl(
  presignedUrl: string,
  data: Buffer,
  contentType: string,
  maxRetries: number = 3,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(presignedUrl, {
        method: "PUT",
        body: data,
        headers: {
          "Content-Type": contentType,
        },
      });

      if (response.ok) {
        return;
      }

      // For 4xx errors (client errors), don't retry
      if (response.status >= 400 && response.status < 500) {
        const text = await response.text();
        throw new Error(`S3 upload failed: ${response.status} - ${text}`);
      }

      // For 5xx errors, retry with backoff
      const text = await response.text();
      lastError = new Error(`S3 upload failed: ${response.status} - ${text}`);
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("Unknown upload error");

      // Don't retry on client errors
      if (
        lastError.message.includes("400") ||
        lastError.message.includes("403")
      ) {
        throw lastError;
      }
    }

    // Exponential backoff: 1s, 2s, 4s...
    if (attempt < maxRetries) {
      const backoffMs = Math.pow(2, attempt - 1) * 1000;
      await sleep(backoffMs);
    }
  }

  throw lastError || new Error("S3 upload failed after retries");
}

/**
 * Options for direct upload
 */
interface DirectUploadOptions {
  onProgress?: ProgressCallback;
  force?: boolean;
}

/**
 * Perform direct S3 upload for a storage (volume or artifact)
 *
 * This bypasses Vercel's 4.5MB request body limit by:
 * 1. Computing file hashes locally
 * 2. Getting presigned URLs from /api/storages/prepare
 * 3. Uploading directly to S3
 * 4. Committing via /api/storages/commit
 */
export async function directUpload(
  storageName: string,
  storageType: "volume" | "artifact",
  cwd: string,
  options?: DirectUploadOptions,
): Promise<DirectUploadResult> {
  const { onProgress, force } = options || {};

  // Step 1: Collect all files
  onProgress?.("Collecting files...");
  const files = await getAllFiles(cwd);

  // Step 2: Compute hashes for all files
  onProgress?.("Computing file hashes...");
  const fileEntries = await collectFileMetadata(cwd, files, onProgress);

  // Step 3: Call prepare endpoint
  onProgress?.("Preparing upload...");
  const prepareResult = await prepareStorage({
    storageName,
    storageType,
    files: fileEntries,
    force,
  });

  // Step 4: Check if version already exists (deduplication)
  // Skip upload but still call commit to update HEAD (fixes #626)
  if (prepareResult.existing) {
    onProgress?.("Version exists, updating HEAD...");

    const commitResult = await commitStorage({
      storageName,
      storageType,
      versionId: prepareResult.versionId,
      files: fileEntries,
    });

    return {
      versionId: commitResult.versionId,
      size: commitResult.size,
      fileCount: commitResult.fileCount,
      deduplicated: true,
      empty: commitResult.fileCount === 0,
    };
  }

  // Step 5: Create and upload archive (skip for empty artifacts)
  if (files.length > 0) {
    onProgress?.("Compressing files...");
    const archiveBuffer = await createArchive(cwd, files);

    onProgress?.("Uploading archive to S3...");
    if (!prepareResult.uploads) {
      throw new Error("No upload URLs received from prepare endpoint");
    }

    await uploadToPresignedUrl(
      prepareResult.uploads.archive.presignedUrl,
      archiveBuffer,
      "application/gzip",
    );
  }

  // Step 6: Create and upload manifest
  onProgress?.("Uploading manifest...");
  if (!prepareResult.uploads) {
    throw new Error("No upload URLs received from prepare endpoint");
  }
  const manifestBuffer = createManifest(fileEntries);
  await uploadToPresignedUrl(
    prepareResult.uploads.manifest.presignedUrl,
    manifestBuffer,
    "application/json",
  );

  // Step 7: Commit the upload
  onProgress?.("Committing...");
  const commitResult = await commitStorage({
    storageName,
    storageType,
    versionId: prepareResult.versionId,
    files: fileEntries,
  });

  return {
    versionId: commitResult.versionId,
    size: commitResult.size,
    fileCount: commitResult.fileCount,
    deduplicated: commitResult.deduplicated || false,
    empty: commitResult.fileCount === 0,
  };
}
