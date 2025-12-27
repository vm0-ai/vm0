import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { storagesPrepareContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { storages, storageVersions } from "../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  generatePresignedPutUrl,
  downloadManifest,
  verifyS3FilesExist,
} from "../../../../src/lib/s3/s3-client";
import { computeContentHashFromHashes } from "../../../../src/lib/storage/content-hash";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:storages:prepare");

const router = tsr.router(storagesPrepareContract, {
  prepare: async ({ body }) => {
    initServices();

    // Authenticate user
    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const {
      storageName,
      storageType,
      files,
      force,
      runId,
      baseVersion,
      changes,
    } = body;

    log.debug(
      `Preparing upload for "${storageName}" (type: ${storageType}), ${files.length} files`,
    );

    // If runId provided, verify it belongs to the user (sandbox auth)
    if (runId) {
      const [run] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
        .limit(1);

      if (!run) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent run not found", code: "NOT_FOUND" },
          },
        };
      }
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
      return {
        status: 500 as const,
        body: {
          error: {
            message: "Failed to create storage",
            code: "INTERNAL_ERROR",
          },
        },
      };
    }

    // Handle incremental upload - merge files with base version
    let mergedFiles = files;
    if (baseVersion && changes) {
      try {
        const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
        if (!bucketName) {
          throw new Error("R2_USER_STORAGES_BUCKET_NAME not configured");
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
          const baseFilesMap = new Map<
            string,
            { path: string; hash: string; size: number }
          >();

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

    // Get bucket name (needed for S3 verification)
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
    if (!bucketName) {
      return {
        status: 500 as const,
        body: {
          error: {
            message: "R2_USER_STORAGES_BUCKET_NAME not configured",
            code: "INTERNAL_ERROR",
          },
        },
      };
    }

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
        // Verify S3 files actually exist before returning existing: true
        // This handles the case where DB record exists but S3 files were deleted
        const s3Exists = await verifyS3FilesExist(
          bucketName,
          existingVersion.s3Key,
          existingVersion.fileCount,
        );

        if (s3Exists) {
          log.debug(
            `Version ${versionId} exists with S3 files, returning existing`,
          );
          return {
            status: 200 as const,
            body: {
              versionId,
              existing: true,
            },
          };
        }

        // S3 files missing - treat as new version, will trigger re-upload
        log.warn(
          `Version ${versionId} exists in DB but S3 files missing, treating as new`,
        );
      }
    } else {
      log.debug(
        `Force flag set, skipping deduplication check for ${versionId}`,
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

    log.debug(`Prepared upload for version ${versionId}`);
    return {
      status: 200 as const,
      body: {
        versionId,
        existing: false,
        uploads: {
          archive: { key: archiveKey, presignedUrl: archiveUrl },
          manifest: { key: manifestKey, presignedUrl: manifestUrl },
        },
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  // Log unexpected errors
  log.error("Prepare error:", err);
  return TsRestResponse.fromJson(
    {
      error: {
        message: err instanceof Error ? err.message : "Prepare failed",
        code: "INTERNAL_ERROR",
      },
    },
    { status: 500 },
  );
}

const handler = createHandler(storagesPrepareContract, router, {
  errorHandler,
});

export { handler as POST };
