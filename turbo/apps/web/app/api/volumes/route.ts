import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { volumes } from "../../../src/db/schema/volume";
import { eq, and } from "drizzle-orm";
import {
  uploadS3Directory,
  deleteS3Directory,
  downloadS3Directory,
} from "../../../src/lib/s3/s3-client";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import AdmZip from "adm-zip";

const S3_BUCKET = "vm0-s3-user-volumes";

/**
 * Validate volume name format
 * Length: 3-64 characters
 * Characters: lowercase letters, numbers, hyphens
 * Must start and end with alphanumeric
 */
function isValidVolumeName(name: string): boolean {
  if (name.length < 3 || name.length > 64) {
    return false;
  }
  const pattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
  return pattern.test(name) && !name.includes("--");
}

/**
 * POST /api/volumes
 * Upload a volume (zip file) to S3
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
    const volumeName = formData.get("volumeName") as string;
    const file = formData.get("file") as File;

    if (!volumeName || !file) {
      return NextResponse.json(
        { error: "Missing volumeName or file" },
        { status: 400 },
      );
    }

    // Validate volume name
    if (!isValidVolumeName(volumeName)) {
      return NextResponse.json(
        {
          error:
            "Invalid volume name. Must be 3-64 characters, lowercase alphanumeric with hyphens, no consecutive hyphens",
        },
        { status: 400 },
      );
    }

    console.log(
      `[Volumes] Uploading volume "${volumeName}" for user ${userId}`,
    );

    // Create temp directory for extraction
    tempDir = path.join(os.tmpdir(), `vm0-volume-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Save uploaded file to temp location
    const zipPath = path.join(tempDir, "upload.zip");
    const arrayBuffer = await file.arrayBuffer();
    await fs.promises.writeFile(zipPath, Buffer.from(arrayBuffer));

    // Extract zip file
    const zip = new AdmZip(zipPath);
    const extractPath = path.join(tempDir, "extracted");
    zip.extractAllTo(extractPath, true);

    console.log(`[Volumes] Extracted zip to ${extractPath}`);

    // Calculate file count and size
    const files = await getAllFiles(extractPath);
    const fileCount = files.length;
    let totalSize = 0;
    for (const filePath of files) {
      const stats = await fs.promises.stat(filePath);
      totalSize += stats.size;
    }

    // Delete existing volume files from S3 if any
    const s3Prefix = `${userId}/${volumeName}`;
    const s3Uri = `s3://${S3_BUCKET}/${s3Prefix}`;

    try {
      await deleteS3Directory(s3Uri);
    } catch (error) {
      console.log(
        `[Volumes] No existing volume to delete or deletion failed:`,
        error,
      );
    }

    // Upload extracted files to S3
    console.log(`[Volumes] Uploading ${fileCount} files to S3...`);
    await uploadS3Directory(extractPath, s3Uri);

    // Create or update volume record in database
    const [existingVolume] = await globalThis.services.db
      .select()
      .from(volumes)
      .where(and(eq(volumes.userId, userId), eq(volumes.name, volumeName)))
      .limit(1);

    if (existingVolume) {
      // Update existing volume
      await globalThis.services.db
        .update(volumes)
        .set({
          s3Prefix,
          size: totalSize,
          fileCount,
          updatedAt: new Date(),
        })
        .where(eq(volumes.id, existingVolume.id));
    } else {
      // Create new volume
      await globalThis.services.db.insert(volumes).values({
        userId,
        name: volumeName,
        s3Prefix,
        size: totalSize,
        fileCount,
      });
    }

    console.log(`[Volumes] Successfully uploaded volume "${volumeName}"`);

    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = null;

    return NextResponse.json({
      volumeName,
      size: totalSize,
      fileCount,
    });
  } catch (error) {
    console.error("[Volumes] Upload error:", error);

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
 * GET /api/volumes?name=volumeName
 * Download a volume as a zip file
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

    // Get volume name from query parameter
    const { searchParams } = new URL(request.url);
    const volumeName = searchParams.get("name");

    if (!volumeName) {
      return NextResponse.json(
        { error: "Missing name parameter" },
        { status: 400 },
      );
    }

    console.log(
      `[Volumes] Downloading volume "${volumeName}" for user ${userId}`,
    );

    // Check if volume exists and belongs to user
    const [volume] = await globalThis.services.db
      .select()
      .from(volumes)
      .where(and(eq(volumes.userId, userId), eq(volumes.name, volumeName)))
      .limit(1);

    if (!volume) {
      return NextResponse.json(
        { error: `Volume "${volumeName}" not found` },
        { status: 404 },
      );
    }

    // Create temp directory for download
    tempDir = path.join(os.tmpdir(), `vm0-volume-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Download files from S3
    const s3Uri = `s3://${S3_BUCKET}/${volume.s3Prefix}`;
    const downloadPath = path.join(tempDir, "download");
    console.log(`[Volumes] Downloading from S3: ${s3Uri}`);
    await downloadS3Directory(s3Uri, downloadPath);

    // Create zip file
    const zipPath = path.join(tempDir, "volume.zip");
    const zip = new AdmZip();
    zip.addLocalFolder(downloadPath);
    zip.writeZip(zipPath);

    console.log(`[Volumes] Created zip file at ${zipPath}`);

    // Read zip file
    const zipBuffer = await fs.promises.readFile(zipPath);

    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = null;

    // Return zip file
    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${volumeName}.zip"`,
      },
    });
  } catch (error) {
    console.error("[Volumes] Download error:", error);

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
