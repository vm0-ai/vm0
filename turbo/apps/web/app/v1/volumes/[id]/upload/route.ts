/**
 * Public API v1 - Volume Upload Endpoint
 *
 * POST /v1/volumes/:id/upload - Get presigned URLs for upload
 */
import { initServices } from "../../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../../src/lib/public-api/handler";
import { publicVolumeUploadContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../../src/lib/public-api/auth";
import {
  storages,
  storageVersions,
} from "../../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { generatePresignedPutUrl } from "../../../../../src/lib/s3/s3-client";
import { computeContentHashFromHashes } from "../../../../../src/lib/storage/content-hash";
import { env } from "../../../../../src/env";
import { randomUUID } from "crypto";

const STORAGE_TYPE = "volume";
const UPLOAD_EXPIRY_SECONDS = 3600; // 1 hour

const router = tsr.router(publicVolumeUploadContract, {
  prepareUpload: async ({ params, body }) => {
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

    // Verify volume exists and belongs to user
    const [volume] = await globalThis.services.db
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

    if (!volume) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such volume: '${params.id}'`,
          },
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

    // Compute version ID from file metadata
    const filesWithHash = body.files.map((f) => ({
      path: f.path,
      size: f.size,
      hash: f.hash || "",
    }));
    const versionId = computeContentHashFromHashes(volume.id, filesWithHash);

    // Check if version already exists (deduplication)
    const [existingVersion] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, volume.id),
          eq(storageVersions.id, versionId),
        ),
      )
      .limit(1);

    if (existingVersion) {
      // Version already exists, return empty upload list
      const expiresAt = new Date(Date.now() + UPLOAD_EXPIRY_SECONDS * 1000);
      return {
        status: 200 as const,
        body: {
          upload_session_id: `existing:${versionId}`,
          files: [],
          expires_at: expiresAt.toISOString(),
        },
      };
    }

    // Generate upload session ID
    const uploadSessionId = `upload:${versionId}:${randomUUID()}`;

    // Generate presigned URLs for archive and manifest
    const s3Key = `${auth.userId}/${STORAGE_TYPE}/${volume.name}/${versionId}`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const manifestKey = `${s3Key}/manifest.json`;

    const [archiveUrl, manifestUrl] = await Promise.all([
      generatePresignedPutUrl(
        bucketName,
        archiveKey,
        "application/gzip",
        UPLOAD_EXPIRY_SECONDS,
      ),
      generatePresignedPutUrl(
        bucketName,
        manifestKey,
        "application/json",
        UPLOAD_EXPIRY_SECONDS,
      ),
    ]);

    const expiresAt = new Date(Date.now() + UPLOAD_EXPIRY_SECONDS * 1000);

    return {
      status: 200 as const,
      body: {
        upload_session_id: uploadSessionId,
        files: [
          {
            path: "archive.tar.gz",
            upload_url: archiveUrl,
            upload_id: archiveKey,
          },
          {
            path: "manifest.json",
            upload_url: manifestUrl,
            upload_id: manifestKey,
          },
        ],
        expires_at: expiresAt.toISOString(),
      },
    };
  },
});

const handler = createPublicApiHandler(publicVolumeUploadContract, router);

export { handler as POST };
