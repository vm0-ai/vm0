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
  generatePresignedPutUrl,
  downloadManifest,
} from "../../../../../../src/lib/s3/s3-client";
import {
  computeContentHashFromHashes,
  type FileEntryWithHash,
} from "../../../../../../src/lib/storage/content-hash";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("webhook:storages:prepare");

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
 * Request body schema for prepare endpoint
 */
interface PrepareRequest {
  runId: string; // Required for webhook - verified against JWT token
  storageName: string;
  storageType: "volume" | "artifact";
  files: FileEntryWithHash[];
  force?: boolean;
  baseVersion?: string;
  changes?: {
    added: string[];
    modified: string[];
    deleted: string[];
  };
}

/**
 * Response schema for prepare endpoint
 */
interface PrepareResponse {
  versionId: string;
  existing: boolean;
  uploads?: {
    archive: { key: string; presignedUrl: string };
    manifest: { key: string; presignedUrl: string };
  };
}

/**
 * POST /api/webhooks/agent/storages/prepare
 *
 * Webhook version of storage prepare endpoint for sandbox use.
 * Uses JWT sandbox token authentication and verifies runId matches token.
 *
 * This endpoint is used by sandbox clients for direct S3 uploads.
 */
export async function POST(request: NextRequest) {
  try {
    initServices();

    // Parse JSON body first to get runId for auth verification
    const body = (await request.json()) as PrepareRequest;
    const {
      runId,
      storageName,
      storageType,
      files,
      force,
      baseVersion,
      changes,
    } = body;

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

    if (!files || !Array.isArray(files)) {
      return errorResponse("files array is required", "BAD_REQUEST", 400);
    }

    log.debug(
      `Preparing upload for "${storageName}" (type: ${storageType}), ${files.length} files, run: ${runId}`,
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

    // Find or create storage
    let [storage] = await globalThis.services.db
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
      // Create new storage if it doesn't exist
      const [newStorage] = await globalThis.services.db
        .insert(storages)
        .values({
          userId,
          name: storageName,
          type: storageType,
          s3Prefix: `${userId}/${storageType}/${storageName}`,
          size: 0,
          fileCount: 0,
        })
        .returning();
      storage = newStorage;
      log.debug(`Created new storage: ${storage?.id}`);
    }

    if (!storage) {
      return errorResponse("Failed to create storage", "INTERNAL_ERROR", 500);
    }

    // Handle incremental upload - merge files with base version
    let mergedFiles = files;
    if (baseVersion && changes) {
      try {
        const bucketName = env().S3_USER_STORAGES_NAME;
        if (!bucketName) {
          throw new Error("S3_USER_STORAGES_NAME not configured");
        }

        // Get base version
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

        if (baseVersionRecord) {
          // Download base manifest
          const baseManifest = await downloadManifest(
            bucketName,
            baseVersionRecord.s3Key,
          );

          // Create map of current files from client
          const currentFilesMap = new Map(files.map((f) => [f.path, f]));

          // Start with base manifest files, excluding deleted ones
          const deletedSet = new Set(changes.deleted || []);
          const baseFilesMap = new Map<string, FileEntryWithHash>();

          for (const file of baseManifest.files) {
            if (!deletedSet.has(file.path) && !currentFilesMap.has(file.path)) {
              baseFilesMap.set(file.path, file);
            }
          }

          // Merge: base files + current files (current overwrites base)
          mergedFiles = [...baseFilesMap.values(), ...files];
          log.debug(
            `Merged files: ${baseManifest.files.length} base + ${files.length} current - ${deletedSet.size} deleted = ${mergedFiles.length} total`,
          );
        }
      } catch (err) {
        log.warn(
          `Failed to process incremental upload, using full files: ${err}`,
        );
        // Fall back to full upload
      }
    }

    // Compute content hash from file metadata
    const versionId = computeContentHashFromHashes(storage.id, mergedFiles);
    log.debug(`Computed version ID: ${versionId}`);

    // Check if version already exists (deduplication) - skip if force is true
    if (!force) {
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
        log.debug(`Version ${versionId} already exists, returning existing`);
        return NextResponse.json({
          versionId,
          existing: true,
        } satisfies PrepareResponse);
      }
    } else {
      log.debug(
        `Force flag set, skipping deduplication check for ${versionId}`,
      );
    }

    // Get bucket name
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      return errorResponse(
        "S3_USER_STORAGES_NAME not configured",
        "INTERNAL_ERROR",
        500,
      );
    }

    // Generate presigned URLs for archive and manifest
    const s3Key = `${userId}/${storageType}/${storageName}/${versionId}`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const manifestKey = `${s3Key}/manifest.json`;

    const [archiveUrl, manifestUrl] = await Promise.all([
      generatePresignedPutUrl(bucketName, archiveKey, "application/gzip", 3600),
      generatePresignedPutUrl(
        bucketName,
        manifestKey,
        "application/json",
        3600,
      ),
    ]);

    const response: PrepareResponse = {
      versionId,
      existing: false,
      uploads: {
        archive: { key: archiveKey, presignedUrl: archiveUrl },
        manifest: { key: manifestKey, presignedUrl: manifestUrl },
      },
    };

    log.debug(`Prepared upload for version ${versionId}`);
    return NextResponse.json(response);
  } catch (error) {
    log.error("Prepare error:", error);
    return errorResponse(
      error instanceof Error ? error.message : "Prepare failed",
      "INTERNAL_ERROR",
      500,
    );
  }
}
