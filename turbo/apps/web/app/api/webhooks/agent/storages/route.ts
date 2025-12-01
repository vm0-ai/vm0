import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  storages,
  storageVersions,
} from "../../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";
import { uploadStorageVersionArchive } from "../../../../../src/lib/s3/s3-client";
import { blobService } from "../../../../../src/lib/blob/blob-service";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as tar from "tar";
import { env } from "../../../../../src/env";
import {
  computeContentHash,
  type FileEntry,
} from "../../../../../src/lib/storage/content-hash";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhook:storages");

interface StorageVersionResponse {
  versionId: string;
  storageName: string;
  size: number;
  fileCount: number;
}

/**
 * POST /api/webhooks/agent/storages
 * Create a new version of a storage from sandbox
 * Accepts multipart form data with storage content as tar.gz
 */
export async function POST(request: NextRequest) {
  let tempDir: string | null = null;

  try {
    // Initialize services
    initServices();

    // Authenticate using bearer token
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Parse multipart form data
    const formData = await request.formData();
    const runId = formData.get("runId") as string;
    const storageName = formData.get("storageName") as string;
    const message = formData.get("message") as string | null;
    const file = formData.get("file") as File;

    // Validate required fields
    if (!runId) {
      throw new BadRequestError("Missing runId");
    }

    if (!storageName) {
      throw new BadRequestError("Missing storageName");
    }

    if (!file) {
      throw new BadRequestError("Missing file");
    }

    log.debug(
      `Received storage version request for "${storageName}" from run ${runId}`,
    );

    // Verify run exists and belongs to the authenticated user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    // Find the storage by name and user
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(and(eq(storages.userId, userId), eq(storages.name, storageName)))
      .limit(1);

    if (!storage) {
      throw new NotFoundError(`Storage "${storageName}"`);
    }

    // Create temp directory for extraction
    tempDir = path.join(os.tmpdir(), `vm0-storage-webhook-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Save uploaded file to temp location
    const tarGzPath = path.join(tempDir, "upload.tar.gz");
    const arrayBuffer = await file.arrayBuffer();
    await fs.promises.writeFile(tarGzPath, Buffer.from(arrayBuffer));

    // Extract tar.gz file
    const extractPath = path.join(tempDir, "extracted");
    // Ensure extract directory exists before extraction (empty archives don't create it)
    await fs.promises.mkdir(extractPath, { recursive: true });
    await tar.extract({
      file: tarGzPath,
      cwd: extractPath,
      gzip: true,
    });

    log.debug(`Extracted tar.gz to ${extractPath}`);

    // Calculate file count, size, and collect file entries for hashing
    const filePaths = await getAllFiles(extractPath);
    const fileCount = filePaths.length;
    let totalSize = 0;
    const fileEntries: FileEntry[] = [];

    for (const filePath of filePaths) {
      const stats = await fs.promises.stat(filePath);
      totalSize += stats.size;

      // Read file content for hash computation
      const content = await fs.promises.readFile(filePath);
      const relativePath = path.relative(extractPath, filePath);
      fileEntries.push({ path: relativePath, content });
    }

    // Compute content-addressable hash for version ID (includes storageId for uniqueness per storage)
    const contentHash = computeContentHash(storage.id, fileEntries);
    log.debug(`Computed content hash: ${contentHash}`);

    // Check if version with same content hash already exists (deduplication)
    const [existingVersion] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, storage.id),
          eq(storageVersions.id, contentHash),
        ),
      )
      .limit(1);

    let versionId: string;
    let deduplicated = false;

    if (existingVersion) {
      // Content already exists, use existing version (deduplication)
      log.debug(
        `Version with same content already exists: ${existingVersion.id}`,
      );
      versionId = existingVersion.id;
      deduplicated = true;
    } else {
      // Create new version record with content hash as ID
      const s3Key = `${userId}/${storageName}/${contentHash}`;

      const [version] = await globalThis.services.db
        .insert(storageVersions)
        .values({
          id: contentHash,
          storageId: storage.id,
          s3Key,
          size: totalSize,
          fileCount,
          message: message || `Checkpoint from run ${runId}`,
          createdBy: "agent",
        })
        .returning();

      if (!version) {
        throw new Error("Failed to create storage version");
      }

      log.debug(`Created version: ${version.id}`);

      // Upload blobs with deduplication
      const blobResult = await blobService.uploadBlobs(fileEntries);
      log.debug(
        `Blob upload: ${blobResult.newBlobsCount} new, ${blobResult.existingBlobsCount} existing`,
      );

      // Upload manifest and archive.tar.gz
      const bucketName = env().S3_USER_STORAGES_NAME;
      if (!bucketName) {
        throw new Error(
          "S3_USER_STORAGES_NAME environment variable is not set",
        );
      }
      const s3Uri = `s3://${bucketName}/${s3Key}`;
      log.debug(`Uploading manifest and archive to ${s3Uri}...`);
      await uploadStorageVersionArchive(
        s3Uri,
        contentHash,
        fileEntries,
        blobResult.hashes,
      );

      versionId = version.id;
    }

    // Update storage's HEAD pointer and metadata
    await globalThis.services.db
      .update(storages)
      .set({
        headVersionId: versionId,
        size: totalSize,
        fileCount,
        updatedAt: new Date(),
      })
      .where(eq(storages.id, storage.id));

    log.debug(
      `Successfully ${deduplicated ? "reused" : "created"} version ${versionId} for storage "${storageName}"`,
    );

    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = null;

    // Return response
    const response: StorageVersionResponse = {
      versionId,
      storageName,
      size: totalSize,
      fileCount,
    };

    return successResponse(response, 200);
  } catch (error) {
    log.error("Error:", error);

    // Clean up temp directory if exists
    if (tempDir) {
      await fs.promises
        .rm(tempDir, { recursive: true, force: true })
        .catch(console.error);
    }

    return errorResponse(error);
  }
}

/**
 * Get all files in directory recursively
 */
async function getAllFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath);
      files.push(...subFiles);
    } else {
      files.push(fullPath);
    }
  }

  return files;
}
