import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { storages, storageVersions } from "../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { s3ObjectExists } from "../../../../src/lib/s3/s3-client";
import {
  computeContentHashFromHashes,
  type FileEntryWithHash,
} from "../../../../src/lib/storage/content-hash";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:storages:commit");

/**
 * Standard error response format
 */
function errorResponse(
  message: string,
  code: string,
  status: number,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

/**
 * Request body schema for commit endpoint
 */
interface CommitRequest {
  storageName: string;
  storageType: "volume" | "artifact";
  versionId: string;
  files: FileEntryWithHash[];
  // Sandbox-specific fields (optional)
  runId?: string;
  message?: string;
}

/**
 * Response schema for commit endpoint
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
 * POST /api/storages/commit
 *
 * Commits a direct S3 upload by:
 * 1. Verifying uploaded files exist in S3 (using HeadObject)
 * 2. Creating blob records in database (with ref counts)
 * 3. Creating storage version record
 * 4. Updating storage HEAD pointer
 *
 * This endpoint is called after the client has uploaded files directly to S3
 * using presigned URLs from the prepare endpoint.
 */
export async function POST(request: NextRequest) {
  try {
    initServices();

    // Authenticate user
    const userId = await getUserId();
    if (!userId) {
      return errorResponse("Not authenticated", "UNAUTHORIZED", 401);
    }

    // Parse JSON body
    const body = (await request.json()) as CommitRequest;
    const { storageName, storageType, versionId, files, runId, message } = body;

    // Validate required fields
    if (!storageName) {
      return errorResponse("storageName is required", "BAD_REQUEST", 400);
    }

    if (
      !storageType ||
      (storageType !== "volume" && storageType !== "artifact")
    ) {
      return errorResponse(
        "storageType must be 'volume' or 'artifact'",
        "BAD_REQUEST",
        400,
      );
    }

    if (!versionId) {
      return errorResponse("versionId is required", "BAD_REQUEST", 400);
    }

    if (!files || !Array.isArray(files)) {
      return errorResponse("files array is required", "BAD_REQUEST", 400);
    }

    log.debug(
      `Committing version ${versionId} for "${storageName}" (type: ${storageType}), ${files.length} files`,
    );

    // If runId provided, verify it belongs to the user (sandbox auth)
    if (runId) {
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
        .limit(1);

      if (!run) {
        return errorResponse("Agent run not found", "NOT_FOUND", 404);
      }
    }

    // Find storage
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

    // Verify version ID matches computed hash
    const computedVersionId = computeContentHashFromHashes(storage.id, files);
    if (computedVersionId !== versionId) {
      return errorResponse(
        "Version ID mismatch - files may have changed",
        "BAD_REQUEST",
        400,
      );
    }

    // Check if version already exists (idempotency)
    const [existingVersion] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, storage.id),
          eq(storageVersions.id, versionId),
        ),
      )
      .limit(1);

    if (existingVersion) {
      // Version already exists, update HEAD pointer if needed
      if (storage.headVersionId !== versionId) {
        await globalThis.services.db
          .update(storages)
          .set({
            headVersionId: versionId,
            updatedAt: new Date(),
          })
          .where(eq(storages.id, storage.id));
      }

      log.debug(`Version ${versionId} already committed, returning success`);
      return NextResponse.json({
        success: true,
        versionId,
        storageName,
        size: Number(existingVersion.size),
        fileCount: existingVersion.fileCount,
        deduplicated: true,
      } satisfies CommitResponse);
    }

    // Get bucket name
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
    if (!bucketName) {
      return errorResponse(
        "R2_USER_STORAGES_BUCKET_NAME not configured",
        "INTERNAL_ERROR",
        500,
      );
    }

    // Verify required S3 objects exist (manifest and archive)
    const s3Key = `${userId}/${storageType}/${storageName}/${versionId}`;
    const manifestKey = `${s3Key}/manifest.json`;
    const archiveKey = `${s3Key}/archive.tar.gz`;

    const [manifestExists, archiveExists] = await Promise.all([
      s3ObjectExists(bucketName, manifestKey),
      s3ObjectExists(bucketName, archiveKey),
    ]);

    if (!manifestExists) {
      return errorResponse(
        "Manifest not uploaded - upload failed or incomplete",
        "BAD_REQUEST",
        400,
      );
    }

    if (!archiveExists) {
      return errorResponse(
        "Archive not uploaded - upload failed or incomplete",
        "BAD_REQUEST",
        400,
      );
    }

    // Calculate totals
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const fileCount = files.length;

    // Use transaction for atomicity
    await globalThis.services.db.transaction(async (tx) => {
      // Create storage version record
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId: storage.id,
          s3Key,
          size: totalSize,
          fileCount,
          message: message || null,
          createdBy: runId ? "agent" : "user",
        })
        .onConflictDoNothing();

      // Update storage HEAD pointer and metadata
      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: totalSize,
          fileCount,
          updatedAt: new Date(),
        })
        .where(eq(storages.id, storage.id));
    });

    log.debug(
      `Committed version ${versionId}: ${fileCount} files, ${totalSize} bytes`,
    );

    return NextResponse.json({
      success: true,
      versionId,
      storageName,
      size: totalSize,
      fileCount,
    } satisfies CommitResponse);
  } catch (error) {
    log.error("Commit error:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Commit failed",
      "INTERNAL_ERROR",
      500,
    );
  }
}
