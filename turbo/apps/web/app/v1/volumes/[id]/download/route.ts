/**
 * Public API v1 - Volume Download Endpoint
 *
 * GET /v1/volumes/:id/download - Get presigned URLs for download
 */
import { initServices } from "../../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../../src/lib/public-api/handler";
import { publicVolumeDownloadContract } from "@vm0/core";
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
  generatePresignedUrl,
  downloadManifest,
} from "../../../../../src/lib/s3/s3-client";
import { resolveVersionByPrefix } from "../../../../../src/lib/storage/version-resolver";
import { env } from "../../../../../src/env";

const STORAGE_TYPE = "volume";
const DOWNLOAD_EXPIRY_SECONDS = 3600; // 1 hour

const router = tsr.router(publicVolumeDownloadContract, {
  download: async ({ params, query }) => {
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

    // Determine which version to download
    let version;
    if (query.version_id) {
      // Resolve version (supports short prefix)
      const resolveResult = await resolveVersionByPrefix(
        volume.id,
        query.version_id,
      );
      if ("error" in resolveResult) {
        return {
          status: 404 as const,
          body: {
            error: {
              type: "not_found_error" as const,
              code: "resource_not_found",
              message: resolveResult.error,
            },
          },
        };
      }
      version = resolveResult.version;
    } else {
      // Use HEAD version
      if (!volume.headVersionId) {
        return {
          status: 404 as const,
          body: {
            error: {
              type: "not_found_error" as const,
              code: "resource_not_found",
              message: `Volume '${volume.name}' has no versions`,
            },
          },
        };
      }

      const [headVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, volume.headVersionId))
        .limit(1);

      if (!headVersion) {
        return {
          status: 404 as const,
          body: {
            error: {
              type: "not_found_error" as const,
              code: "resource_not_found",
              message: `Volume '${volume.name}' HEAD version not found`,
            },
          },
        };
      }
      version = headVersion;
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

    // Handle empty volume case
    if (version.fileCount === 0) {
      const expiresAt = new Date(Date.now() + DOWNLOAD_EXPIRY_SECONDS * 1000);
      return {
        status: 200 as const,
        body: {
          version_id: version.id,
          files: [],
          expires_at: expiresAt.toISOString(),
        },
      };
    }

    // Download manifest to get file list
    const manifest = await downloadManifest(bucketName, version.s3Key);
    const expiresAt = new Date(Date.now() + DOWNLOAD_EXPIRY_SECONDS * 1000);

    // Generate presigned URL for archive download
    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const archiveUrl = await generatePresignedUrl(
      bucketName,
      archiveKey,
      DOWNLOAD_EXPIRY_SECONDS,
    );

    // Return files from manifest with single archive download URL
    const files = manifest.files.map((f: { path: string; size: number }) => ({
      path: f.path,
      size: f.size,
      download_url: archiveUrl, // All files are in the same archive
    }));

    return {
      status: 200 as const,
      body: {
        version_id: version.id,
        files,
        expires_at: expiresAt.toISOString(),
      },
    };
  },
});

const handler = createPublicApiHandler(publicVolumeDownloadContract, router);

export { handler as GET };
