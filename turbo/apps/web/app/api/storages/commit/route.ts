import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { storagesCommitContract } from "@vm0/api-contracts/contracts/storages";
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
  s3ObjectExists,
  verifyS3FilesExist,
} from "../../../../src/lib/infra/s3/s3-client";
import { computeContentHashFromHashes } from "../../../../src/lib/infra/storage/content-hash";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:storages:commit");

const router = tsr.router(storagesCommitContract, {
  commit: async ({ body, headers }) => {
    initServices();

    const { storageName, storageType, versionId, files, runId, message } = body;

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    log.debug(
      `Committing version ${versionId} for "${storageName}" (type: ${storageType}), ${files.length} files`,
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

    // Volumes use sentinel userId; artifacts/memory use real userId
    const storageUserId =
      storageType === "volume" ? VOLUME_ORG_USER_ID : userId;

    // Find storage
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.orgId, runtimeOrg.orgId),
          eq(storages.userId, storageUserId),
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
              message: "Storage service is not properly configured",
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
            message: "Storage service is not properly configured",
            code: "INTERNAL_ERROR",
          },
        },
      };
    }

    // Verify required S3 objects exist
    // For empty artifacts (fileCount === 0), only manifest is required
    // since there's no archive to extract
    const s3Key = `${storage.s3Prefix}/${versionId}`;
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
    const totalSize = files.reduce((sum: number, f: { size: number }) => {
      return sum + f.size;
    }, 0);

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

const handler = createHandler(storagesCommitContract, router, {
  routeName: "storages.commit",
});

export { handler as POST };
