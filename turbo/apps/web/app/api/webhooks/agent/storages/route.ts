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
import { uploadS3Directory } from "../../../../../src/lib/s3/s3-client";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import AdmZip from "adm-zip";
import { env } from "../../../../../src/env";

interface StorageVersionResponse {
  versionId: string;
  storageName: string;
  size: number;
  fileCount: number;
}

/**
 * POST /api/webhooks/agent/storages
 * Create a new version of a storage from sandbox
 * Accepts multipart form data with storage content as zip
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

    console.log(
      `[Storage Webhook] Received storage version request for "${storageName}" from run ${runId}`,
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
    const zipPath = path.join(tempDir, "upload.zip");
    const arrayBuffer = await file.arrayBuffer();
    await fs.promises.writeFile(zipPath, Buffer.from(arrayBuffer));

    // Extract zip file
    const zip = new AdmZip(zipPath);
    const extractPath = path.join(tempDir, "extracted");
    zip.extractAllTo(extractPath, true);

    console.log(`[Storage Webhook] Extracted zip to ${extractPath}`);

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
    const s3Key = `${userId}/${storageName}/${versionId}`;

    const [version] = await globalThis.services.db
      .insert(storageVersions)
      .values({
        id: versionId,
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

    console.log(`[Storage Webhook] Created version: ${version.id}`);

    // Upload files to versioned S3 path
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      throw new Error("S3_USER_STORAGES_NAME environment variable is not set");
    }
    const s3Uri = `s3://${bucketName}/${s3Key}`;
    console.log(
      `[Storage Webhook] Uploading ${fileCount} files to ${s3Uri}...`,
    );
    await uploadS3Directory(extractPath, s3Uri);

    // Update storage's HEAD pointer and metadata
    await globalThis.services.db
      .update(storages)
      .set({
        headVersionId: version.id,
        size: totalSize,
        fileCount,
        updatedAt: new Date(),
      })
      .where(eq(storages.id, storage.id));

    console.log(
      `[Storage Webhook] Successfully created version ${version.id} for storage "${storageName}"`,
    );

    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = null;

    // Return response
    const response: StorageVersionResponse = {
      versionId: version.id,
      storageName,
      size: totalSize,
      fileCount,
    };

    return successResponse(response, 200);
  } catch (error) {
    console.error("[Storage Webhook] Error:", error);

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
