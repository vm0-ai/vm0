import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as tar from "tar";
import { apiClient } from "./api-client";
import { excludeVm0Filter } from "./file-utils";

/**
 * File entry with pre-computed hash for direct upload
 */
export interface FileEntryWithHash {
  path: string;
  hash: string;
  size: number;
}

/**
 * Prepare response from the server
 */
interface PrepareResponse {
  versionId: string;
  existing: boolean;
  uploads?: {
    blobs: Array<{ hash: string; presignedUrl: string }>;
    archive: { key: string; presignedUrl: string };
    manifest: { key: string; presignedUrl: string };
  };
}

/**
 * Commit response from the server
 */
interface CommitResponse {
  success: boolean;
  versionId: string;
  storageName: string;
  size: number;
  fileCount: number;
  deduplicated?: boolean;
}

/**
 * Result of direct upload operation
 */
export interface DirectUploadResult {
  versionId: string;
  size: number;
  fileCount: number;
  deduplicated: boolean;
}

/**
 * Progress callback for upload operations
 */
export type ProgressCallback = (message: string) => void;

/**
 * Compute SHA-256 hash of file content
 */
export function hashFileContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Get all files in directory recursively, excluding .vm0/
 */
export async function getAllFiles(
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
 * Collect file metadata with hashes
 */
export async function collectFileMetadata(
  cwd: string,
  files: string[],
  onProgress?: ProgressCallback,
): Promise<FileEntryWithHash[]> {
  const fileEntries: FileEntryWithHash[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const relativePath = path.relative(cwd, file);
    const content = await fs.promises.readFile(file);
    const hash = hashFileContent(content);
    const size = content.length;

    fileEntries.push({
      path: relativePath,
      hash,
      size,
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
export async function createArchive(
  cwd: string,
  files: string[],
): Promise<Buffer> {
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
export function createManifest(files: FileEntryWithHash[]): Buffer {
  const manifest = {
    version: 1,
    files,
    createdAt: new Date().toISOString(),
  };
  return Buffer.from(JSON.stringify(manifest, null, 2));
}

/**
 * Upload buffer to presigned URL
 */
async function uploadToPresignedUrl(
  presignedUrl: string,
  data: Buffer,
  contentType: string,
): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: "PUT",
    body: data,
    headers: {
      "Content-Type": contentType,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`S3 upload failed: ${response.status} - ${text}`);
  }
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
  onProgress?: ProgressCallback,
): Promise<DirectUploadResult> {
  // Step 1: Collect all files
  onProgress?.("Collecting files...");
  const files = await getAllFiles(cwd);

  // Step 2: Compute hashes for all files
  onProgress?.("Computing file hashes...");
  const fileEntries = await collectFileMetadata(cwd, files, onProgress);

  // Calculate total size
  const totalSize = fileEntries.reduce((sum, f) => sum + f.size, 0);

  // Step 3: Call prepare endpoint
  onProgress?.("Preparing upload...");
  const prepareResponse = await apiClient.post("/api/storages/prepare", {
    body: JSON.stringify({
      storageName,
      storageType,
      files: fileEntries,
    }),
  });

  if (!prepareResponse.ok) {
    const error = (await prepareResponse.json()) as {
      error: { message: string; code: string };
    };
    throw new Error(error.error?.message || "Prepare failed");
  }

  const prepareResult = (await prepareResponse.json()) as PrepareResponse;

  // Step 4: Check if version already exists (deduplication)
  if (prepareResult.existing) {
    return {
      versionId: prepareResult.versionId,
      size: totalSize,
      fileCount: fileEntries.length,
      deduplicated: true,
    };
  }

  // Step 5: Create and upload archive
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

  // Step 6: Create and upload manifest
  onProgress?.("Uploading manifest...");
  const manifestBuffer = createManifest(fileEntries);
  await uploadToPresignedUrl(
    prepareResult.uploads.manifest.presignedUrl,
    manifestBuffer,
    "application/json",
  );

  // Step 7: Commit the upload
  onProgress?.("Committing...");
  const commitResponse = await apiClient.post("/api/storages/commit", {
    body: JSON.stringify({
      storageName,
      storageType,
      versionId: prepareResult.versionId,
      files: fileEntries,
    }),
  });

  if (!commitResponse.ok) {
    const error = (await commitResponse.json()) as {
      error: { message: string; code: string };
    };
    throw new Error(error.error?.message || "Commit failed");
  }

  const commitResult = (await commitResponse.json()) as CommitResponse;

  return {
    versionId: commitResult.versionId,
    size: commitResult.size,
    fileCount: commitResult.fileCount,
    deduplicated: commitResult.deduplicated || false,
  };
}
