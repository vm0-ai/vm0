import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { volumes, volumeVersions } from "../../../../../src/db/schema/volume";
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
import { uploadS3Directory } from "../../../../../src/lib/s3/s3-client";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import AdmZip from "adm-zip";

const S3_BUCKET = "vm0-s3-user-volumes";

interface VolumeVersionResponse {
  versionId: string;
  volumeName: string;
  size: number;
  fileCount: number;
}

/**
 * POST /api/webhooks/agent/volumes
 * Create a new version of a VM0 volume from sandbox
 * Accepts multipart form data with volume content as tar.gz
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
    const volumeName = formData.get("volumeName") as string;
    const message = formData.get("message") as string | null;
    const file = formData.get("file") as File;

    // Validate required fields
    if (!runId) {
      throw new BadRequestError("Missing runId");
    }

    if (!volumeName) {
      throw new BadRequestError("Missing volumeName");
    }

    if (!file) {
      throw new BadRequestError("Missing file");
    }

    console.log(
      `[Volume Webhook] Received volume version request for "${volumeName}" from run ${runId}`,
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

    // Find the volume by name and user
    const [volume] = await globalThis.services.db
      .select()
      .from(volumes)
      .where(and(eq(volumes.userId, userId), eq(volumes.name, volumeName)))
      .limit(1);

    if (!volume) {
      throw new NotFoundError(`Volume "${volumeName}"`);
    }

    // Create temp directory for extraction
    tempDir = path.join(os.tmpdir(), `vm0-volume-webhook-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Save uploaded file to temp location
    const zipPath = path.join(tempDir, "upload.zip");
    const arrayBuffer = await file.arrayBuffer();
    await fs.promises.writeFile(zipPath, Buffer.from(arrayBuffer));

    // Extract zip file
    const zip = new AdmZip(zipPath);
    const extractPath = path.join(tempDir, "extracted");
    zip.extractAllTo(extractPath, true);

    console.log(`[Volume Webhook] Extracted zip to ${extractPath}`);

    // Calculate file count and size
    const files = await getAllFiles(extractPath);
    const fileCount = files.length;
    let totalSize = 0;
    for (const filePath of files) {
      const stats = await fs.promises.stat(filePath);
      totalSize += stats.size;
    }

    // Create new version record
    const versionId = crypto.randomUUID();
    const s3Key = `${userId}/${volumeName}/${versionId}`;

    const [version] = await globalThis.services.db
      .insert(volumeVersions)
      .values({
        id: versionId,
        volumeId: volume.id,
        s3Key,
        size: totalSize,
        fileCount,
        message: message || `Checkpoint from run ${runId}`,
        createdBy: "agent",
      })
      .returning();

    if (!version) {
      throw new Error("Failed to create volume version");
    }

    console.log(`[Volume Webhook] Created version: ${version.id}`);

    // Upload files to versioned S3 path
    const s3Uri = `s3://${S3_BUCKET}/${s3Key}`;
    console.log(`[Volume Webhook] Uploading ${fileCount} files to ${s3Uri}...`);
    await uploadS3Directory(extractPath, s3Uri);

    // Update volume's HEAD pointer and metadata
    await globalThis.services.db
      .update(volumes)
      .set({
        headVersionId: version.id,
        size: totalSize,
        fileCount,
        updatedAt: new Date(),
      })
      .where(eq(volumes.id, volume.id));

    console.log(
      `[Volume Webhook] Successfully created version ${version.id} for volume "${volumeName}"`,
    );

    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = null;

    // Return response
    const response: VolumeVersionResponse = {
      versionId: version.id,
      volumeName,
      size: totalSize,
      fileCount,
    };

    return successResponse(response, 200);
  } catch (error) {
    console.error("[Volume Webhook] Error:", error);

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
