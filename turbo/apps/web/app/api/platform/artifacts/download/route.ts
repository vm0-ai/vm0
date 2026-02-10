/**
 * Platform API - Artifact Download Endpoint
 *
 * GET /api/platform/artifacts/download - Get presigned URL for artifact download
 */
import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { platformArtifactDownloadContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  storages,
  storageVersions,
} from "../../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { generatePresignedUrl } from "../../../../../src/lib/s3/s3-client";
import { resolveVersionByPrefix } from "../../../../../src/lib/storage/version-resolver";
import { env } from "../../../../../src/env";

const STORAGE_TYPE = "artifact";
const DOWNLOAD_EXPIRY_SECONDS = 3600; // 1 hour

/**
 * Create unauthorized response
 */
function unauthorizedResponse() {
  return {
    status: 401 as const,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
}

/**
 * Create not found response
 */
function notFoundResponse(message: string) {
  return {
    status: 404 as const,
    body: {
      error: { message, code: "NOT_FOUND" },
    },
  };
}

const router = tsr.router(platformArtifactDownloadContract, {
  getDownloadUrl: async ({ query }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return unauthorizedResponse();
    }

    const { name, version: versionId } = query;

    // Find artifact by name for this user
    const [artifact] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.name, name),
          eq(storages.userId, userId),
          eq(storages.type, STORAGE_TYPE),
        ),
      )
      .limit(1);

    if (!artifact) {
      return notFoundResponse(`Artifact '${name}' not found`);
    }

    // Determine which version to download
    let version;
    if (versionId) {
      // Resolve version (supports short prefix)
      const resolveResult = await resolveVersionByPrefix(
        artifact.id,
        versionId,
      );
      if ("error" in resolveResult) {
        return notFoundResponse(resolveResult.error);
      }
      version = resolveResult.version;
    } else {
      // Use HEAD version
      if (!artifact.headVersionId) {
        return notFoundResponse(`Artifact '${name}' has no versions`);
      }

      const [headVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, artifact.headVersionId))
        .limit(1);

      if (!headVersion) {
        return notFoundResponse(`Artifact '${name}' HEAD version not found`);
      }
      version = headVersion;
    }

    // Get bucket name
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
    if (!bucketName) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: "Storage service not configured",
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Handle empty artifact case
    if (version.fileCount === 0) {
      return notFoundResponse(`Artifact '${name}' version has no files`);
    }

    // Generate presigned URL for archive download with custom filename
    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const downloadFilename = `${name}-${version.id}.tar.gz`;
    const archiveUrl = await generatePresignedUrl(
      bucketName,
      archiveKey,
      DOWNLOAD_EXPIRY_SECONDS,
      downloadFilename,
      true,
    );

    // Calculate expiration time
    const expiresAt = new Date(
      Date.now() + DOWNLOAD_EXPIRY_SECONDS * 1000,
    ).toISOString();

    return {
      status: 200 as const,
      body: {
        url: archiveUrl,
        expiresAt,
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "queryError" in err) {
    const validationError = err as {
      queryError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
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

  return undefined;
}

const handler = createHandler(platformArtifactDownloadContract, router, {
  errorHandler,
});

export { handler as GET };
