import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import {
  storagesPrepareContract,
  MAX_FILE_SIZE_BYTES,
} from "@vm0/api-contracts/contracts/storages";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { eq, and } from "drizzle-orm";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { isSandboxAuth } from "../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  generatePresignedPutUrl,
  downloadManifest,
  verifyS3FilesExist,
} from "../../../../src/lib/infra/s3/s3-client";
import { computeContentHashFromHashes } from "../../../../src/lib/infra/storage/content-hash";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:storages:prepare");

/**
 * Handle incremental upload - merge files with base version
 */
async function mergeWithBaseVersion(
  storageId: string,
  files: Array<{ path: string; hash: string; size: number }>,
  baseVersion: string,
  changes: { deleted?: string[] },
): Promise<Array<{ path: string; hash: string; size: number }>> {
  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("Storage service is not properly configured");
  }

  // Get base version
  const [baseVersionRecord] = await globalThis.services.db
    .select()
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storageId),
        eq(storageVersions.id, baseVersion),
      ),
    )
    .limit(1);

  if (!baseVersionRecord) {
    return files;
  }

  // Download base manifest
  const baseManifest = await downloadManifest(
    bucketName,
    baseVersionRecord.s3Key,
  );

  // Create map of current files from client
  const currentFilesMap = new Map(
    files.map((f) => {
      return [f.path, f];
    }),
  );

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
  const mergedFiles = [...baseFilesMap.values(), ...files];
  log.debug(
    `Merged files: ${baseManifest.files.length} base + ${files.length} current - ${deletedSet.size} deleted = ${mergedFiles.length} total`,
  );

  return mergedFiles;
}

const router = tsr.router(storagesPrepareContract, {
  prepare: async ({ body, headers }) => {
    initServices();

    const {
      storageName,
      storageType,
      files,
      force,
      runId,
      baseVersion,
      changes,
    } = body;

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    // Validate total declared file size (100MB per-file limit is enforced by schema)
    const totalDeclaredSize = files.reduce(
      (sum: number, f: { size: number }) => {
        return sum + f.size;
      },
      0,
    );
    if (totalDeclaredSize > MAX_FILE_SIZE_BYTES) {
      return {
        status: 413 as const,
        body: {
          error: {
            message: "Upload rejected: total file size exceeds 100MB limit",
            code: "PAYLOAD_TOO_LARGE",
          },
        },
      };
    }

    log.debug(
      `Preparing upload for "${storageName}" (type: ${storageType}), ${files.length} files`,
    );

    // Resolve org: sandbox tokens use the run's org; CLI/session use resolveOrg
    let runtimeOrg: { orgId: string };
    if (isSandboxAuth(authCtx)) {
      // Sandbox: run lookup also verifies ownership (runId + userId from signed JWT)
      const [run] = await globalThis.services.db
        .select({ orgId: agentRuns.orgId })
        .from(agentRuns)
        .where(
          and(eq(agentRuns.id, authCtx.runId), eq(agentRuns.userId, userId)),
        )
        .limit(1);
      if (!run) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent run not found", code: "NOT_FOUND" },
          },
        };
      }
      runtimeOrg = { orgId: run.orgId };
    } else {
      const { org } = await resolveOrg(authCtx);
      runtimeOrg = org;

      // For CLI tokens, verify body.runId belongs to the user if provided
      if (runId) {
        const [run] = await globalThis.services.db
          .select({ id: agentRuns.id })
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
    }

    // Volumes use sentinel userId (org-level shared); artifacts/memory use real userId
    const storageUserId =
      storageType === "volume" ? VOLUME_ORG_USER_ID : userId;

    // Find or create storage (upsert to handle concurrent requests)
    const [storage] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: storageUserId,
        orgId: runtimeOrg.orgId,
        name: storageName,
        type: storageType,
        s3Prefix: `${runtimeOrg.orgId}/${storageType}/${storageName}`,
        size: 0,
        fileCount: 0,
      })
      .onConflictDoUpdate({
        target: [storages.orgId, storages.userId, storages.name, storages.type],
        set: { updatedAt: new Date() },
      })
      .returning();

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

    log.debug(`Storage ready: ${storage.id}`);

    // Handle incremental upload - merge files with base version
    let mergedFiles = files;
    if (baseVersion && changes) {
      try {
        mergedFiles = await mergeWithBaseVersion(
          storage.id,
          files,
          baseVersion,
          changes,
        );
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
            message: "Storage service is not properly configured",
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
    const s3Key = `${storage.s3Prefix}/${versionId}`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const manifestKey = `${s3Key}/manifest.json`;

    const [archiveUrl, manifestUrl] = await Promise.all([
      generatePresignedPutUrl(
        bucketName,
        archiveKey,
        "application/gzip",
        3600,
        true,
      ),
      generatePresignedPutUrl(
        bucketName,
        manifestKey,
        "application/json",
        3600,
        true,
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

const handler = createHandler(storagesPrepareContract, router, {
  routeName: "storages.prepare",
});

export { handler as POST };
