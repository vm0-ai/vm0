import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import {
  storages,
  storageVersions,
} from "../../../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../../src/lib/auth/get-sandbox-auth";
import {
  s3ObjectExists,
  verifyS3FilesExist,
} from "../../../../../../src/lib/s3/s3-client";
import {
  computeContentHashFromHashes,
  type FileEntryWithHash,
} from "../../../../../../src/lib/storage/content-hash";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("webhook:storages:commit");

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
  runId: string; // Required for webhook - verified against JWT token
  storageName: string;
  storageType: "volume" | "artifact";
  versionId: string;
  files: FileEntryWithHash[];
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
 * POST /api/webhooks/agent/storages/commit
 *
 * Webhook version of storage commit endpoint for sandbox use.
 * Uses JWT sandbox token authentication and verifies runId matches token.
 *
 * This endpoint is called after the client has uploaded files directly to S3
 * using presigned URLs from the prepare endpoint.
 */
export async function POST(request: NextRequest) {
  try {
    initServices();

    // Parse JSON body first to get runId for auth verification
    const body = (await request.json()) as CommitRequest;
    const { runId, storageName, storageType, versionId, files, message } = body;

    // Validate runId is provided
    if (!runId) {
      return errorResponse("runId is required", "BAD_REQUEST", 400);
    }

    // Authenticate with sandbox JWT and verify runId matches
    const auth = await getSandboxAuthForRun(runId);
    if (!auth) {
      return errorResponse(
        "Not authenticated or runId mismatch",
        "UNAUTHORIZED",
        401,
      );
    }

    const { userId } = auth;

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
      `Committing version ${versionId} for "${storageName}" (type: ${storageType}), ${files.length} files, run: ${runId}`,
    );

    // Verify run exists and belongs to the user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return errorResponse("Agent run not found", "NOT_FOUND", 404);
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
      // Get bucket name for S3 verification
      const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
      if (!bucketName) {
        return errorResponse(
          "R2_USER_STORAGES_BUCKET_NAME not configured",
          "INTERNAL_ERROR",
          500,
        );
      }

      // Defense-in-depth: verify S3 files exist before updating HEAD
      // This catches edge cases where S3 files were deleted between prepare and commit
      const s3Exists = await verifyS3FilesExist(
        bucketName,
        existingVersion.s3Key,
        existingVersion.fileCount,
      );

      if (!s3Exists) {
        log.error(
          `Version ${versionId} exists in DB but S3 files missing - cannot commit`,
        );
        return errorResponse(
          "S3 files missing for existing version - please retry upload",
          "S3_FILES_MISSING",
          409,
        );
      }

      // Version already exists with valid S3 files, update HEAD pointer if needed
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
          createdBy: "agent",
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
