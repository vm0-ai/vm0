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
import AdmZip from "adm-zip";
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
 * Validate storage name format
 * Length: 3-64 characters
 * Characters: lowercase letters, numbers, hyphens
 * Must start and end with alphanumeric
 */
function isValidStorageName(name: string): boolean {
  if (name.length < 3 || name.length > 64) {
    return false;
  }
  const pattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
  return pattern.test(name) && !name.includes("--");
}

/**
 * POST /api/storages
 * Upload a storage (zip file) to S3
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
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Parse multipart form data
    const formData = await request.formData();
    const storageName = formData.get("name") as string;
    const file = formData.get("file") as File;
    const storageType = (formData.get("type") as string) || "volume"; // Default to "volume"
    const forceUpload = formData.get("force") === "true"; // Skip deduplication if true

    if (!storageName || !file) {
      return NextResponse.json(
        { error: "Missing name or file" },
        { status: 400 },
      );
    }

    // Validate storage type
    if (storageType !== "volume" && storageType !== "artifact") {
      return NextResponse.json(
        { error: "Invalid type. Must be 'volume' or 'artifact'" },
        { status: 400 },
      );
    }

    // Validate storage name
    if (!isValidStorageName(storageName)) {
      return NextResponse.json(
        {
          error:
            "Invalid storage name. Must be 3-64 characters, lowercase alphanumeric with hyphens, no consecutive hyphens",
        },
        { status: 400 },
      );
    }

    log.debug(
      `Uploading storage "${storageName}" (type: ${storageType}) for user ${userId}`,
    );

    // Create temp directory for extraction
    tempDir = path.join(os.tmpdir(), `vm0-storage-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Save uploaded file to temp location
    const zipPath = path.join(tempDir, "upload.zip");
    const arrayBuffer = await file.arrayBuffer();
    await fs.promises.writeFile(zipPath, Buffer.from(arrayBuffer));

    // Extract zip file
    const zip = new AdmZip(zipPath);
    const extractPath = path.join(tempDir, "extracted");
    // Ensure extract directory exists before extraction (empty zips don't create it)
    await fs.promises.mkdir(extractPath, { recursive: true });
    zip.extractAllTo(extractPath, true);

    log.debug(`Extracted zip to ${extractPath}`);

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
    const existingStorages = await globalThis.services.db
      .select()
      .from(storages)
      .where(and(eq(storages.userId, userId), eq(storages.name, storageName)))
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
            s3Prefix: `${userId}/${storageName}`,
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
      const s3Key = `${userId}/${storageName}/${contentHash}`;
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
    console.error("[Storage] Upload error:", error);

    // Clean up temp directory if exists
    if (tempDir) {
      await fs.promises
        .rm(tempDir, { recursive: true, force: true })
        .catch(console.error);
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Upload failed",
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/storages?name=storageName&version=versionId
 * Download a storage as a zip file
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
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const storageName = searchParams.get("name");
    const versionId = searchParams.get("version");

    if (!storageName) {
      return NextResponse.json(
        { error: "Missing name parameter" },
        { status: 400 },
      );
    }

    log.debug(
      `Downloading storage "${storageName}"${versionId ? ` version ${versionId}` : ""} for user ${userId}`,
    );

    // Check if storage exists and belongs to user
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(and(eq(storages.userId, userId), eq(storages.name, storageName)))
      .limit(1);

    if (!storage) {
      return NextResponse.json(
        { error: `Storage "${storageName}" not found` },
        { status: 404 },
      );
    }

    // Determine which version to download
    let version;
    if (versionId) {
      // Resolve version (supports short prefix)
      const resolveResult = await resolveVersionByPrefix(storage.id, versionId);
      if ("error" in resolveResult) {
        return NextResponse.json(
          { error: resolveResult.error },
          { status: resolveResult.status },
        );
      }
      version = resolveResult.version;
    } else {
      // Use HEAD version
      if (!storage.headVersionId) {
        return NextResponse.json(
          { error: `Storage "${storageName}" has no versions` },
          { status: 404 },
        );
      }

      // Get HEAD version details
      const [headVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, storage.headVersionId))
        .limit(1);

      if (!headVersion) {
        return NextResponse.json(
          { error: `Storage "${storageName}" HEAD version not found` },
          { status: 404 },
        );
      }
      version = headVersion;
    }

    log.debug(`Downloading version ${version.id} (${version.fileCount} files)`);

    // Create temp directory for download
    tempDir = path.join(os.tmpdir(), `vm0-storage-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Download archive.tar.gz from S3
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      return NextResponse.json(
        { error: "S3_USER_STORAGES_NAME environment variable is not set" },
        { status: 500 },
      );
    }
    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const tarGzPath = path.join(tempDir, "archive.tar.gz");
    log.debug(`Downloading archive from S3: ${archiveKey}`);
    await downloadS3Object(bucketName, archiveKey, tarGzPath);

    // Extract tar.gz to download directory using JavaScript tar library
    // (Vercel serverless doesn't have system tar command)
    const downloadPath = path.join(tempDir, "download");
    await fs.promises.mkdir(downloadPath, { recursive: true });
    await tar.extract({
      file: tarGzPath,
      cwd: downloadPath,
      gzip: true,
    });

    // Create zip file for response (CLI expects zip format)
    const zipPath = path.join(tempDir, "storage.zip");
    const zip = new AdmZip();
    zip.addLocalFolder(downloadPath);
    zip.writeZip(zipPath);

    log.debug(`Created zip file at ${zipPath}`);

    // Read zip file
    const zipBuffer = await fs.promises.readFile(zipPath);

    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = null;

    // Return zip file
    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${storageName}.zip"`,
      },
    });
  } catch (error) {
    console.error("[Storage] Download error:", error);

    // Clean up temp directory if exists
    if (tempDir) {
      await fs.promises
        .rm(tempDir, { recursive: true, force: true })
        .catch(console.error);
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Download failed",
      },
      { status: 500 },
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
