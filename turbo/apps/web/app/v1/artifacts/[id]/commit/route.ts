/**
 * Public API v1 - Artifact Commit Endpoint
 *
 * POST /v1/artifacts/:id/commit - Finalize upload and create version
 */
import { initServices } from "../../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../../src/lib/public-api/handler";
import { publicArtifactCommitContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../../src/lib/public-api/auth";
import {
  storages,
  storageVersions,
} from "../../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import {
  s3ObjectExists,
  downloadManifest,
} from "../../../../../src/lib/s3/s3-client";
import { env } from "../../../../../src/env";

const STORAGE_TYPE = "artifact";

const router = tsr.router(publicArtifactCommitContract, {
  commitUpload: async ({ params, body }) => {
    initServices();

    const auth = await authenticatePublicApi();
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Verify artifact exists and belongs to user
    const [artifact] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.id, params.id),
          eq(storages.userId, auth.userId),
          eq(storages.type, STORAGE_TYPE),
        ),
      )
      .limit(1);

    if (!artifact) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such artifact: '${params.id}'`,
          },
        },
      };
    }

    // Parse upload session ID to get version ID
    const sessionParts = body.upload_session_id.split(":");
    if (sessionParts.length < 2) {
      return {
        status: 400 as const,
        body: {
          error: {
            type: "invalid_request_error" as const,
            code: "invalid_parameter",
            message: "Invalid upload_session_id format",
          },
        },
      };
    }

    const sessionType = sessionParts[0];
    const versionId = sessionParts[1]!;

    // Handle existing version case
    if (sessionType === "existing") {
      const [existingVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, versionId))
        .limit(1);

      if (!existingVersion) {
        return {
          status: 400 as const,
          body: {
            error: {
              type: "invalid_request_error" as const,
              code: "invalid_parameter",
              message: "Version not found",
            },
          },
        };
      }

      // Update HEAD pointer if needed
      if (artifact.headVersionId !== versionId) {
        await globalThis.services.db
          .update(storages)
          .set({
            headVersionId: versionId,
            updatedAt: new Date(),
          })
          .where(eq(storages.id, artifact.id));
      }

      return {
        status: 200 as const,
        body: {
          id: existingVersion.id,
          artifact_id: artifact.id,
          size: Number(existingVersion.size),
          file_count: existingVersion.fileCount,
          message: existingVersion.message,
          created_by: existingVersion.createdBy,
          created_at: existingVersion.createdAt.toISOString(),
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
            type: "api_error" as const,
            code: "internal_error",
            message: "Storage service not configured",
          },
        },
      };
    }

    // Verify S3 objects exist
    const s3Key = `${auth.userId}/${STORAGE_TYPE}/${artifact.name}/${versionId}`;
    const manifestKey = `${s3Key}/manifest.json`;
    const archiveKey = `${s3Key}/archive.tar.gz`;

    const [manifestExists, archiveExists] = await Promise.all([
      s3ObjectExists(bucketName, manifestKey),
      s3ObjectExists(bucketName, archiveKey),
    ]);

    if (!manifestExists) {
      return {
        status: 400 as const,
        body: {
          error: {
            type: "invalid_request_error" as const,
            code: "upload_incomplete",
            message: "Manifest not uploaded - upload failed or incomplete",
          },
        },
      };
    }

    // Download manifest to get file info
    let fileCount = 0;
    let totalSize = 0;

    if (archiveExists) {
      const manifest = await downloadManifest(bucketName, s3Key);
      fileCount = manifest.files.length;
      totalSize = manifest.files.reduce(
        (sum: number, f: { size: number }) => sum + f.size,
        0,
      );
    }

    // Check if version already exists (idempotency)
    const [existingVersion] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, artifact.id),
          eq(storageVersions.id, versionId),
        ),
      )
      .limit(1);

    if (existingVersion) {
      // Update HEAD and return existing
      if (artifact.headVersionId !== versionId) {
        await globalThis.services.db
          .update(storages)
          .set({
            headVersionId: versionId,
            updatedAt: new Date(),
          })
          .where(eq(storages.id, artifact.id));
      }

      return {
        status: 200 as const,
        body: {
          id: existingVersion.id,
          artifact_id: artifact.id,
          size: Number(existingVersion.size),
          file_count: existingVersion.fileCount,
          message: existingVersion.message,
          created_by: existingVersion.createdBy,
          created_at: existingVersion.createdAt.toISOString(),
        },
      };
    }

    // Create version and update storage in transaction
    const now = new Date();
    await globalThis.services.db.transaction(async (tx) => {
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId: artifact.id,
          s3Key,
          size: totalSize,
          fileCount,
          message: body.message || null,
          createdBy: "user",
        })
        .onConflictDoNothing();

      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: totalSize,
          fileCount,
          updatedAt: now,
        })
        .where(eq(storages.id, artifact.id));
    });

    return {
      status: 200 as const,
      body: {
        id: versionId,
        artifact_id: artifact.id,
        size: totalSize,
        file_count: fileCount,
        message: body.message || null,
        created_by: "user",
        created_at: now.toISOString(),
      },
    };
  },
});

const handler = createPublicApiHandler(publicArtifactCommitContract, router);

export { handler as POST };
