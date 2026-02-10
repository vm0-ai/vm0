import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { storagesDownloadContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { storages, storageVersions } from "../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { getUserScopeByClerkId } from "../../../../src/lib/scope/scope-service";
import { generatePresignedUrl } from "../../../../src/lib/s3/s3-client";
import { env } from "../../../../src/env";
import { resolveVersionByPrefix } from "../../../../src/lib/storage/version-resolver";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:storages:download");

const router = tsr.router(storagesDownloadContract, {
  download: async ({ query, headers }) => {
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

    // Resolve user's scope
    const userScope = await getUserScopeByClerkId(userId);
    if (!userScope) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "User scope not found. Please run: vm0 auth login",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    const { name: storageName, type: storageType, version: versionId } = query;

    log.debug(
      `Getting download URL for "${storageName}" (type: ${storageType})${versionId ? ` version ${versionId}` : ""} for scope ${userScope.slug}`,
    );

    // Check if storage exists and belongs to user's scope
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.scopeId, userScope.id),
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

    // Determine which version to download
    let version;
    if (versionId) {
      // Resolve version (supports short prefix)
      const resolveResult = await resolveVersionByPrefix(storage.id, versionId);
      if ("error" in resolveResult) {
        const status = resolveResult.status === 404 ? 404 : 400;
        return {
          status: status as 400 | 404,
          body: {
            error: {
              message: resolveResult.error,
              code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST",
            },
          },
        };
      }
      version = resolveResult.version;
    } else {
      // Use HEAD version
      if (!storage.headVersionId) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: `Storage "${storageName}" has no versions`,
              code: "NOT_FOUND",
            },
          },
        };
      }

      // Get HEAD version details
      const [headVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, storage.headVersionId))
        .limit(1);

      if (!headVersion) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: `Storage "${storageName}" HEAD version not found`,
              code: "NOT_FOUND",
            },
          },
        };
      }
      version = headVersion;
    }

    log.debug(`Generating presigned URL for version ${version.id}`);

    // Handle empty artifact case - return empty flag
    if (version.fileCount === 0) {
      log.debug("Empty artifact, returning empty response");
      return {
        status: 200 as const,
        body: {
          empty: true as const,
          versionId: version.id,
          fileCount: 0 as const,
          size: 0 as const,
        },
      };
    }

    // Generate presigned URL for archive.tar.gz
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

    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    // URL valid for 1 hour (3600 seconds)
    const url = await generatePresignedUrl(
      bucketName,
      archiveKey,
      3600,
      undefined,
      true,
    );

    log.debug(`Generated presigned URL for ${archiveKey}`);

    return {
      status: 200 as const,
      body: {
        url,
        versionId: version.id,
        fileCount: version.fileCount,
        size: Number(version.size),
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

  // Log unexpected errors
  log.error("Download error:", err);
  return TsRestResponse.fromJson(
    {
      error: {
        message: err instanceof Error ? err.message : "Download failed",
        code: "INTERNAL_ERROR",
      },
    },
    { status: 500 },
  );
}

const handler = createHandler(storagesDownloadContract, router, {
  errorHandler,
});

export { handler as GET };
