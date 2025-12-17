import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { storages, storageVersions } from "../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import {
  uploadStorageVersionArchive,
  downloadS3Object,
} from "../../../src/lib/s3/s3-client";
import { blobService } from "../../../src/lib/blob/blob-service";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as tar from "tar";
import { env } from "../../../src/env";
import {
  computeContentHash,
  type FileEntry,
} from "../../../src/lib/storage/content-hash";

import { resolveVersionByPrefix } from "../../../src/lib/storage/version-resolver";
import { logger } from "../../../src/lib/logger";

const log = logger("api:storages");

/**
 * Helper to create standardized error response
 * Matches apiErrorSchema: { error: { message, code } }
 */
function errorResponse(
  message: string,
  code: string,
  status: number,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

/**
 * Check if name is a system storage name
 * System storage names use @ format:
 * - system-prompt@{name} for system prompts
 * - system-skill@{path} for system skills
 */
function isSystemStorageName(name: string): boolean {
  return name.startsWith("system-prompt@") || name.startsWith("system-skill@");
}

/**
 * Validate storage name format
 *
 * Regular storage names:
 * - Length: 3-64 characters
 * - Characters: lowercase letters, numbers, hyphens
 * - Must start and end with alphanumeric
 * - No consecutive hyphens
 *
 * System storage names (@ format):
 * - system-prompt@{name} for system prompts (name: alphanumeric with hyphens)
 * - system-skill@{path} for system skills (path: GitHub path with slashes, dots, hyphens)
 * - Length: up to 256 characters
 */
function isValidStorageName(name: string): boolean {
  // System storage names have different validation rules
  if (isSystemStorageName(name)) {
    // Length: up to 256 characters (DB limit is 256)
    if (name.length < 15 || name.length > 256) {
      return false;
    }
    // Must be a valid system storage type
    // system-prompt@agent-name
    const systemPromptPattern = /^system-prompt@[a-zA-Z0-9-]+$/;
    // system-skill@owner/repo/tree/branch/path (allows dots for branch names like v1.0)
    const systemSkillPattern = /^system-skill@[a-zA-Z0-9/._-]+$/;
    return systemPromptPattern.test(name) || systemSkillPattern.test(name);
  }

  // Regular storage names
  if (name.length < 3 || name.length > 64) {
    return false;
  }
  const pattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
  return pattern.test(name) && !name.includes("--");
}

/**
 * POST /api/storages
 * Upload a storage (tar.gz file) to S3
 *
 * Content-Type: multipart/form-data
 * Form fields:
 * - name: string (storage name, 3-64 chars, lowercase alphanumeric with hyphens)
 * - file: File (tar.gz archive)
 * - type: "volume" | "artifact" (optional, defaults to "volume")
 * - force: "true" | "false" (optional, skip deduplication)
 *
 * Uses database transaction to ensure atomicity:
 * - If S3 upload fails, storage and version records are rolled back
 * - Prevents orphaned storages without HEAD version pointer
 */
export async function POST(request: NextRequest) {
  let tempDir: string | null = null;

  try {
    // Initialize services
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      return errorResponse("Not authenticated", "UNAUTHORIZED", 401);
    }

    // Parse multipart form data
    const formData = await request.formData();
    const storageName = formData.get("name") as string;
    const file = formData.get("file") as File;
    const storageType = (formData.get("type") as string) || "volume"; // Default to "volume"
    const forceUpload = formData.get("force") === "true"; // Skip deduplication if true

    if (!storageName || !file) {
      return errorResponse("Missing name or file", "BAD_REQUEST", 400);
    }

    // Validate storage type
    if (storageType !== "volume" && storageType !== "artifact") {
      return errorResponse(
        "Invalid type. Must be 'volume' or 'artifact'",
        "BAD_REQUEST",
        400,
      );
    }

    // Validate storage name
    if (!isValidStorageName(storageName)) {
      return errorResponse(
        "Invalid storage name. Must be 3-64 characters, lowercase alphanumeric with hyphens, no consecutive hyphens",
        "BAD_REQUEST",
        400,
      );
    }

    log.debug(
      `Uploading storage "${storageName}" (type: ${storageType}) for user ${userId}`,
    );

    // Create temp directory for extraction
    tempDir = path.join(os.tmpdir(), `vm0-storage-${Date.now()}`);
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

    // Check if storage already exists (outside transaction for read)
    // Must include type in query since same name can exist for different types
    const existingStorages = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.userId, userId),
          eq(storages.name, storageName),
          eq(storages.type, storageType),
        ),
      )
      .limit(1);

    const existingStorage = existingStorages[0];

    // Use transaction to ensure atomicity of storage/version creation and S3 upload
    // If any step fails, all database changes are rolled back
    const result = await globalThis.services.db.transaction(async (tx) => {
      let storage = existingStorage;

      if (!storage) {
        // Create new storage record within transaction
        const newStorages = await tx
          .insert(storages)
          .values({
            userId,
            name: storageName,
            s3Prefix: `${userId}/${storageType}/${storageName}`,
            size: totalSize,
            fileCount,
            type: storageType,
          })
          .returning();
        storage = newStorages[0];
        if (!storage) {
          throw new Error("Failed to create storage");
        }
        log.debug(`Created new storage record: ${storage.id}`);
      }

      // Compute content-addressable hash for version ID (includes storageId for uniqueness per storage)
      const contentHash = computeContentHash(storage.id, fileEntries);
      log.debug(`Computed content hash: ${contentHash}`);

      // Check if version with same content hash already exists (deduplication)
      // Skip deduplication if forceUpload is true (to recreate archive.tar.gz for old versions)
      if (!forceUpload) {
        const [existingVersion] = await tx
          .select()
          .from(storageVersions)
          .where(
            and(
              eq(storageVersions.storageId, storage.id),
              eq(storageVersions.id, contentHash),
            ),
          )
          .limit(1);

        if (existingVersion) {
          // Content already exists, return existing version (deduplication)
          log.debug(
            `Version with same content already exists: ${existingVersion.id}`,
          );

          // Update HEAD pointer to existing version if needed
          if (storage.headVersionId !== existingVersion.id) {
            await tx
              .update(storages)
              .set({
                headVersionId: existingVersion.id,
                updatedAt: new Date(),
              })
              .where(eq(storages.id, storage.id));
          }

          return {
            name: storageName,
            versionId: existingVersion.id,
            size: Number(existingVersion.size),
            fileCount: existingVersion.fileCount,
            type: storageType,
            deduplicated: true,
          };
        }
      } else {
        log.debug("Force upload enabled, skipping deduplication check");
      }

      // Create new version record with content hash as ID
      // Use onConflictDoNothing to handle force upload case where version already exists
      const s3Key = `${userId}/${storageType}/${storageName}/${contentHash}`;
      const createdVersions = await tx
        .insert(storageVersions)
        .values({
          id: contentHash,
          storageId: storage.id,
          s3Key,
          size: totalSize,
          fileCount,
          message: null,
          createdBy: "user",
        })
        .onConflictDoNothing()
        .returning();

      const version = createdVersions[0];
      const versionId = version?.id ?? contentHash;
      const versionS3Key = version?.s3Key ?? s3Key;

      if (version) {
        log.debug(`Created version: ${version.id}`);
      } else {
        log.debug(`Version ${contentHash} already exists, recreating archive`);
      }

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
      const s3Uri = `s3://${bucketName}/${versionS3Key}`;
      log.debug(`Uploading manifest and archive to ${s3Uri}...`);
      await uploadStorageVersionArchive(
        s3Uri,
        contentHash,
        fileEntries,
        blobResult.hashes,
      );

      // Update storage's HEAD pointer and metadata within transaction
      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: totalSize,
          fileCount,
          updatedAt: new Date(),
        })
        .where(eq(storages.id, storage.id));

      log.debug(
        `Successfully uploaded storage "${storageName}" version ${versionId}`,
      );

      return {
        name: storageName,
        versionId,
        size: totalSize,
        fileCount,
        type: storageType,
        deduplicated: false,
      };
    });

    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = null;

    return NextResponse.json(result);
  } catch (error) {
    log.error("Upload error:", error);

    // Clean up temp directory if exists
    if (tempDir) {
      await fs.promises
        .rm(tempDir, { recursive: true, force: true })
        .catch((err) => log.error("Failed to clean up temp directory:", err));
    }

    return errorResponse(
      error instanceof Error ? error.message : "Upload failed",
      "INTERNAL_ERROR",
      500,
    );
  }
}

/**
 * GET /api/storages?name=storageName&version=versionId
 * Download a storage as a tar.gz file
 *
 * Query params:
 * - name: string (required, storage name)
 * - version: string (optional, version ID or prefix)
 *
 * Returns: Binary tar.gz file (application/gzip)
 *
 * If version is specified, download that specific version
 * Otherwise, download the HEAD (latest) version
 */
export async function GET(request: NextRequest) {
  let tempDir: string | null = null;

  try {
    // Initialize services
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      return errorResponse("Not authenticated", "UNAUTHORIZED", 401);
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const storageName = searchParams.get("name");
    const storageType = searchParams.get("type");
    const versionId = searchParams.get("version");

    if (!storageName) {
      return errorResponse("Missing name parameter", "BAD_REQUEST", 400);
    }

    if (!storageType) {
      return errorResponse("Missing type parameter", "BAD_REQUEST", 400);
    }

    // Validate storage type
    if (storageType !== "volume" && storageType !== "artifact") {
      return errorResponse(
        "Invalid type. Must be 'volume' or 'artifact'",
        "BAD_REQUEST",
        400,
      );
    }

    log.debug(
      `Downloading storage "${storageName}" (type: ${storageType})${versionId ? ` version ${versionId}` : ""} for user ${userId}`,
    );

    // Check if storage exists and belongs to user
    // Must include type in query since same name can exist for different types
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.userId, userId),
          eq(storages.name, storageName),
          eq(storages.type, storageType),
        ),
      )
      .limit(1);

    if (!storage) {
      return errorResponse(
        `Storage "${storageName}" not found`,
        "NOT_FOUND",
        404,
      );
    }

    // Determine which version to download
    let version;
    if (versionId) {
      // Resolve version (supports short prefix)
      const resolveResult = await resolveVersionByPrefix(storage.id, versionId);
      if ("error" in resolveResult) {
        return errorResponse(
          resolveResult.error,
          resolveResult.status === 404 ? "NOT_FOUND" : "BAD_REQUEST",
          resolveResult.status,
        );
      }
      version = resolveResult.version;
    } else {
      // Use HEAD version
      if (!storage.headVersionId) {
        return errorResponse(
          `Storage "${storageName}" has no versions`,
          "NOT_FOUND",
          404,
        );
      }

      // Get HEAD version details
      const [headVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, storage.headVersionId))
        .limit(1);

      if (!headVersion) {
        return errorResponse(
          `Storage "${storageName}" HEAD version not found`,
          "NOT_FOUND",
          404,
        );
      }
      version = headVersion;
    }

    log.debug(`Downloading version ${version.id} (${version.fileCount} files)`);

    // Handle empty artifact case - return empty tar.gz without downloading from S3
    // Empty archives created by archiver may not be valid tar format
    if (version.fileCount === 0) {
      log.debug("Empty artifact, returning empty tar.gz");
      // Create an empty tar.gz file
      tempDir = path.join(os.tmpdir(), `vm0-storage-${Date.now()}`);
      await fs.promises.mkdir(tempDir, { recursive: true });
      const emptyDir = path.join(tempDir, "empty");
      await fs.promises.mkdir(emptyDir, { recursive: true });
      const emptyTarPath = path.join(tempDir, "empty.tar.gz");
      await tar.create(
        {
          gzip: true,
          file: emptyTarPath,
          cwd: emptyDir,
        },
        ["."],
      );
      const emptyTarBuffer = await fs.promises.readFile(emptyTarPath);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
      return new NextResponse(new Uint8Array(emptyTarBuffer), {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${storageName}.tar.gz"`,
        },
      });
    }

    // Create temp directory for download
    tempDir = path.join(os.tmpdir(), `vm0-storage-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Download archive.tar.gz from S3
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      return errorResponse(
        "S3_USER_STORAGES_NAME environment variable is not set",
        "INTERNAL_ERROR",
        500,
      );
    }
    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const tarGzPath = path.join(tempDir, "archive.tar.gz");
    log.debug(`Downloading archive from S3: ${archiveKey}`);
    await downloadS3Object(bucketName, archiveKey, tarGzPath);

    // Read tar.gz file directly (no conversion needed)
    const tarGzBuffer = await fs.promises.readFile(tarGzPath);

    log.debug(`Returning tar.gz file (${tarGzBuffer.length} bytes)`);

    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = null;

    // Return tar.gz file directly
    return new NextResponse(new Uint8Array(tarGzBuffer), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${storageName}.tar.gz"`,
      },
    });
  } catch (error) {
    log.error("Download error:", error);

    // Clean up temp directory if exists
    if (tempDir) {
      await fs.promises
        .rm(tempDir, { recursive: true, force: true })
        .catch((err) => log.error("Failed to clean up temp directory:", err));
    }

    return errorResponse(
      error instanceof Error ? error.message : "Download failed",
      "INTERNAL_ERROR",
      500,
    );
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
