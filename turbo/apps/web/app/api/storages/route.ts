import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { storages, storageVersions } from "../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import {
  uploadS3Directory,
  downloadS3Directory,
} from "../../../src/lib/s3/s3-client";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import AdmZip from "adm-zip";

const S3_BUCKET = "vm0-s3-user-storages";

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

    console.log(
      `[Storage] Uploading storage "${storageName}" (type: ${storageType}) for user ${userId}`,
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
    zip.extractAllTo(extractPath, true);

    console.log(`[Storage] Extracted zip to ${extractPath}`);

    // Calculate file count and size
    const files = await getAllFiles(extractPath);
    const fileCount = files.length;
    let totalSize = 0;
    for (const filePath of files) {
      const stats = await fs.promises.stat(filePath);
      totalSize += stats.size;
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
        console.log(`[Storage] Created new storage record: ${storage.id}`);
      }

      // Create new version record within transaction
      const createdVersions = await tx
        .insert(storageVersions)
        .values({
          storageId: storage.id,
          s3Key: `${userId}/${storageName}/${crypto.randomUUID()}`,
          size: totalSize,
          fileCount,
          message: null,
          createdBy: "user",
        })
        .returning();

      const version = createdVersions[0];

      if (!version) {
        throw new Error("Failed to create storage version");
      }

      console.log(`[Storage] Created version: ${version.id}`);

      // Upload files to versioned S3 path
      // If this fails, the transaction will be rolled back
      const s3Uri = `s3://${S3_BUCKET}/${version.s3Key}`;
      console.log(`[Storage] Uploading ${fileCount} files to ${s3Uri}...`);
      await uploadS3Directory(extractPath, s3Uri);

      // Update storage's HEAD pointer and metadata within transaction
      await tx
        .update(storages)
        .set({
          headVersionId: version.id,
          size: totalSize,
          fileCount,
          updatedAt: new Date(),
        })
        .where(eq(storages.id, storage.id));

      console.log(
        `[Storage] Successfully uploaded storage "${storageName}" version ${version.id}`,
      );

      return {
        name: storageName,
        versionId: version.id,
        size: totalSize,
        fileCount,
        type: storageType,
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
 * GET /api/storages?name=storageName
 * Download a storage as a zip file
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

    // Get storage name from query parameter
    const { searchParams } = new URL(request.url);
    const storageName = searchParams.get("name");

    if (!storageName) {
      return NextResponse.json(
        { error: "Missing name parameter" },
        { status: 400 },
      );
    }

    console.log(
      `[Storage] Downloading storage "${storageName}" for user ${userId}`,
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

    // Check if storage has a HEAD version
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

    console.log(
      `[Storage] Downloading HEAD version ${headVersion.id} (${headVersion.fileCount} files)`,
    );

    // Create temp directory for download
    tempDir = path.join(os.tmpdir(), `vm0-storage-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Download files from versioned S3 path
    const s3Uri = `s3://${S3_BUCKET}/${headVersion.s3Key}`;
    const downloadPath = path.join(tempDir, "download");
    console.log(`[Storage] Downloading from S3: ${s3Uri}`);
    await downloadS3Directory(s3Uri, downloadPath);

    // Create zip file
    const zipPath = path.join(tempDir, "storage.zip");
    const zip = new AdmZip();
    zip.addLocalFolder(downloadPath);
    zip.writeZip(zipPath);

    console.log(`[Storage] Created zip file at ${zipPath}`);

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
