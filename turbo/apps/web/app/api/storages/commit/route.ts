import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { storagesCommitContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { storages, storageVersions } from "../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  s3ObjectExists,
  verifyS3FilesExist,
} from "../../../../src/lib/s3/s3-client";
import { computeContentHashFromHashes } from "../../../../src/lib/storage/content-hash";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:storages:commit");

const router = tsr.router(storagesCommitContract, {
  commit: async ({ body, headers }) => {
    initServices();

    // Authenticate user
    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const { storageName, storageType, versionId, files, runId, message } = body;

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
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent run not found", code: "NOT_FOUND" },
          },
        };
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
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Storage "${storageName}" not found`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Verify version ID matches computed hash
    const computedVersionId = computeContentHashFromHashes(storage.id, files);
    if (computedVersionId !== versionId) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Version ID mismatch - files may have changed",
            code: "BAD_REQUEST",
          },
        },
      };
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
        return {
          status: 409 as const,
          body: {
            error: {
              message:
                "S3 files missing for existing version - please retry upload",
              code: "S3_FILES_MISSING",
            },
          },
        };
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
      return {
        status: 200 as const,
        body: {
          success: true as const,
          versionId,
          storageName,
          size: Number(existingVersion.size),
          fileCount: existingVersion.fileCount,
          deduplicated: true,
        },
      };
    }

    // Get bucket name
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

    // Verify required S3 objects exist
    // For empty artifacts (fileCount === 0), only manifest is required
    // since there's no archive to extract
    const s3Key = `${userId}/${storageType}/${storageName}/${versionId}`;
    const manifestKey = `${s3Key}/manifest.json`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const fileCount = files.length;

    const [manifestExists, archiveExists] = await Promise.all([
      s3ObjectExists(bucketName, manifestKey),
      fileCount > 0
        ? s3ObjectExists(bucketName, archiveKey)
        : Promise.resolve(true),
    ]);

    if (!manifestExists) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Manifest not uploaded - upload failed or incomplete",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    if (fileCount > 0 && !archiveExists) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Archive not uploaded - upload failed or incomplete",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Calculate totals
    const totalSize = files.reduce(
      (sum: number, f: { size: number }) => sum + f.size,
      0,
    );

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

      // Verify version exists (either we inserted it or another transaction did and committed)
      // This prevents FK violation when concurrent transactions race on the same versionId
      const [version] = await tx
        .select({ id: storageVersions.id })
        .from(storageVersions)
        .where(eq(storageVersions.id, versionId))
        .limit(1);

      if (!version) {
        throw new Error(
          `Version ${versionId} not found after insert - concurrent transaction may not have committed yet`,
        );
      }

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

    return {
      status: 200 as const,
      body: {
        success: true as const,
        versionId,
        storageName,
        size: totalSize,
        fileCount,
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
  log.error("Commit error:", err);
  return TsRestResponse.fromJson(
    {
      error: {
        message: err instanceof Error ? err.message : "Commit failed",
        code: "INTERNAL_ERROR",
      },
    },
    { status: 500 },
  );
}

const handler = createHandler(storagesCommitContract, router, {
  errorHandler,
});

export { handler as POST };
