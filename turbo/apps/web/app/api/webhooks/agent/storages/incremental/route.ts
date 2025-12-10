import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import {
  storages,
  storageVersions,
} from "../../../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import {
  downloadManifest,
  createArchiveFromBlobs,
  uploadS3Buffer,
} from "../../../../../../src/lib/s3/s3-client";
import { blobService } from "../../../../../../src/lib/blob/blob-service";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as tar from "tar";
import { env } from "../../../../../../src/env";
import {
  computeContentHash,
  type FileEntry,
} from "../../../../../../src/lib/storage/content-hash";
import { logger } from "../../../../../../src/lib/logger";
import type {
  S3StorageManifest,
  FileEntryWithHash,
} from "../../../../../../src/lib/s3/types";

const log = logger("webhook:storages:incremental");

interface ChangesPayload {
  added: string[];
  modified: string[];
  deleted: string[];
}

/**
 * Standard error response format matching ts-rest API pattern
 */
function errorResponse(
  message: string,
  code: string,
  status: number,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

/**
 * POST /api/webhooks/agent/storages/incremental
 * Create a new version of a storage using incremental upload
 * Only uploads changed files, reusing blob references for unchanged files
 *
 * Note: This endpoint handles binary file upload which doesn't fit
 * the standard ts-rest JSON handler pattern. Error responses are
 * standardized to match other ts-rest endpoints.
 */
export async function POST(request: NextRequest) {
  let tempDir: string | null = null;

  try {
    // Initialize services
    initServices();

    // Authenticate using bearer token
    const userId = await getUserId();
    if (!userId) {
      return errorResponse("Not authenticated", "UNAUTHORIZED", 401);
    }

    // Parse multipart form data
    const formData = await request.formData();
    const runId = formData.get("runId") as string;
    const storageName = formData.get("storageName") as string;
    const baseVersion = formData.get("baseVersion") as string;
    const changesJson = formData.get("changes") as string;
    const message = formData.get("message") as string | null;
    const file = formData.get("file") as File | null;

    // Validate required fields
    if (!runId) {
      return errorResponse("runId: runId is required", "BAD_REQUEST", 400);
    }

    if (!storageName) {
      return errorResponse(
        "storageName: storageName is required",
        "BAD_REQUEST",
        400,
      );
    }

    if (!baseVersion) {
      return errorResponse(
        "baseVersion: baseVersion is required",
        "BAD_REQUEST",
        400,
      );
    }

    if (!changesJson) {
      return errorResponse("changes: changes is required", "BAD_REQUEST", 400);
    }

    let changes: ChangesPayload;
    try {
      changes = JSON.parse(changesJson) as ChangesPayload;
    } catch {
      return errorResponse("changes: Invalid JSON", "BAD_REQUEST", 400);
    }

    // Validate ChangesPayload structure
    if (
      !Array.isArray(changes.added) ||
      !Array.isArray(changes.modified) ||
      !Array.isArray(changes.deleted)
    ) {
      return errorResponse(
        "changes: added, modified, and deleted must be arrays",
        "BAD_REQUEST",
        400,
      );
    }

    log.debug(
      `Received incremental upload for "${storageName}" from run ${runId}, base: ${baseVersion.slice(0, 8)}`,
    );
    log.debug(
      `Changes: +${changes.added.length} ~${changes.modified.length} -${changes.deleted.length}`,
    );

    // Verify run exists and belongs to the authenticated user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return errorResponse("Agent run not found", "NOT_FOUND", 404);
    }

    // Find the storage by name and user
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(and(eq(storages.userId, userId), eq(storages.name, storageName)))
      .limit(1);

    if (!storage) {
      return errorResponse(
        `Storage "${storageName}" not found`,
        "NOT_FOUND",
        404,
      );
    }

    // Get base version info
    const [baseVersionRecord] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, storage.id),
          eq(storageVersions.id, baseVersion),
        ),
      )
      .limit(1);

    if (!baseVersionRecord) {
      return errorResponse(
        `Base version "${baseVersion}" not found`,
        "NOT_FOUND",
        404,
      );
    }

    // Download base manifest from S3
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      throw new Error("S3_USER_STORAGES_NAME environment variable is not set");
    }

    const baseManifest = await downloadManifest(
      bucketName,
      baseVersionRecord.s3Key,
    );
    log.debug(
      `Downloaded base manifest: ${baseManifest.fileCount} files, ${baseManifest.totalSize} bytes`,
    );

    // Build a map of base files for quick lookup
    const baseFilesMap = new Map<string, FileEntryWithHash>();
    for (const f of baseManifest.files) {
      baseFilesMap.set(f.path, f);
    }

    // Process uploaded file (contains added + modified files)
    const newFileEntries: FileEntry[] = [];
    let bytesUploaded = 0;

    if (file && (changes.added.length > 0 || changes.modified.length > 0)) {
      // Create temp directory for extraction
      tempDir = path.join(os.tmpdir(), `vm0-storage-incremental-${Date.now()}`);
      await fs.promises.mkdir(tempDir, { recursive: true });

      // Save uploaded file to temp location
      const tarGzPath = path.join(tempDir, "upload.tar.gz");
      const arrayBuffer = await file.arrayBuffer();
      await fs.promises.writeFile(tarGzPath, Buffer.from(arrayBuffer));

      // Extract tar.gz file
      const extractPath = path.join(tempDir, "extracted");
      await fs.promises.mkdir(extractPath, { recursive: true });
      await tar.extract({
        file: tarGzPath,
        cwd: extractPath,
        gzip: true,
      });

      // Read new/modified files
      const changedPaths = new Set([...changes.added, ...changes.modified]);
      for (const relativePath of changedPaths) {
        // Security: Validate path to prevent path traversal attacks
        if (
          relativePath.includes("..") ||
          path.isAbsolute(relativePath) ||
          relativePath.startsWith("/")
        ) {
          return errorResponse(
            `Invalid file path: ${relativePath}`,
            "BAD_REQUEST",
            400,
          );
        }

        const filePath = path.join(extractPath, relativePath);

        // Additional security check: ensure resolved path is within extractPath
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(path.resolve(extractPath) + path.sep)) {
          return errorResponse(
            `Invalid file path: ${relativePath}`,
            "BAD_REQUEST",
            400,
          );
        }

        try {
          const content = await fs.promises.readFile(filePath);
          newFileEntries.push({ path: relativePath, content });
          bytesUploaded += content.length;
        } catch (err) {
          log.warn(`File not found in upload: ${relativePath}`, err);
        }
      }
    }

    // Upload new blobs
    const blobResult = await blobService.uploadBlobs(newFileEntries);
    log.debug(
      `Blob upload: ${blobResult.newBlobsCount} new, ${blobResult.existingBlobsCount} existing`,
    );

    // Build merged file list
    const mergedFiles: FileEntryWithHash[] = [];

    // 1. Add unchanged files from base (excluding deleted and modified)
    const deletedSet = new Set(changes.deleted);
    const modifiedSet = new Set(changes.modified);
    let unchangedCount = 0;

    for (const [filePath, fileInfo] of baseFilesMap) {
      if (!deletedSet.has(filePath) && !modifiedSet.has(filePath)) {
        mergedFiles.push(fileInfo);
        unchangedCount++;
      }
    }

    // 2. Add new and modified files
    for (const entry of newFileEntries) {
      const hash = blobResult.hashes.get(entry.path);
      if (hash) {
        mergedFiles.push({
          path: entry.path,
          hash,
          size: entry.content.length,
        });
      }
    }

    // Sort by path for consistent ordering
    mergedFiles.sort((a, b) => a.path.localeCompare(b.path));

    // Compute content hash for new version
    // We need to reconstruct FileEntry[] with content for hash computation
    // But we can compute it from the merged files directly
    const hashEntries: FileEntry[] = [];
    const blobContents = await blobService.downloadBlobs(
      mergedFiles.map((f) => f.hash),
    );

    for (const f of mergedFiles) {
      const content = blobContents.get(f.hash);
      if (content) {
        hashEntries.push({ path: f.path, content });
      }
    }

    const contentHash = computeContentHash(storage.id, hashEntries);
    log.debug(`Computed content hash: ${contentHash}`);

    // Check for duplicate version
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
    const totalSize = mergedFiles.reduce((sum, f) => sum + f.size, 0);
    const fileCount = mergedFiles.length;

    if (existingVersion) {
      log.debug(
        `Version with same content already exists: ${existingVersion.id}`,
      );
      versionId = existingVersion.id;
      deduplicated = true;
    } else {
      // Create new version record
      const s3Key = `${userId}/${storageName}/${contentHash}`;

      const [version] = await globalThis.services.db
        .insert(storageVersions)
        .values({
          id: contentHash,
          storageId: storage.id,
          s3Key,
          size: totalSize,
          fileCount,
          message: message || `Incremental checkpoint from run ${runId}`,
          createdBy: "agent",
        })
        .returning();

      if (!version) {
        throw new Error("Failed to create storage version");
      }

      log.debug(`Created version: ${version.id}`);

      // Create manifest
      const manifest: S3StorageManifest = {
        version: contentHash,
        createdAt: new Date().toISOString(),
        totalSize,
        fileCount,
        files: mergedFiles,
      };

      // Upload manifest
      const manifestJson = JSON.stringify(manifest, null, 2);
      await uploadS3Buffer(
        bucketName,
        `${s3Key}/manifest.json`,
        Buffer.from(manifestJson),
      );

      // Create archive from blobs
      await createArchiveFromBlobs(
        bucketName,
        `${s3Key}/archive.tar.gz`,
        mergedFiles.map((f) => ({
          path: f.path,
          blobHash: f.hash,
          size: f.size,
        })),
      );

      versionId = version.id;
    }

    // Update storage's HEAD pointer
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
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }

    // Return response
    return NextResponse.json({
      versionId,
      storageName,
      size: totalSize,
      fileCount,
      incrementalStats: {
        addedFiles: changes.added.length,
        modifiedFiles: changes.modified.length,
        deletedFiles: changes.deleted.length,
        unchangedFiles: unchangedCount,
        bytesUploaded,
      },
    });
  } catch (error) {
    log.error("Error:", error);

    // Clean up temp directory if exists
    if (tempDir) {
      await fs.promises
        .rm(tempDir, { recursive: true, force: true })
        .catch(console.error);
    }

    return errorResponse(
      error instanceof Error ? error.message : "Internal server error",
      "INTERNAL_ERROR",
      500,
    );
  }
}
