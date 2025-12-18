import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { storages, storageVersions } from "../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { generatePresignedUrl } from "../../../../src/lib/s3/s3-client";
import { env } from "../../../../src/env";
import { resolveVersionByPrefix } from "../../../../src/lib/storage/version-resolver";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:storages:download");

/**
 * Helper to create standardized error response
 * Matches apiErrorSchema: { error: { message, code } }
 */
function errorResponse(
  message: string,
  code: string,
  status: number,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

/**
 * GET /api/storages/download?name=storageName&type=volume&version=versionId
 * Get a presigned URL for downloading a storage archive from S3
 *
 * Query params:
 * - name: string (required, storage name)
 * - type: "volume" | "artifact" (required)
 * - version: string (optional, version ID or prefix)
 *
 * Returns: JSON with presigned S3 URL
 * {
 *   url: string (presigned GET URL, valid for 1 hour)
 *   versionId: string
 *   fileCount: number
 *   size: number
 * }
 *
 * If version is specified, returns URL for that specific version
 * Otherwise, returns URL for the HEAD (latest) version
 *
 * For empty artifacts (fileCount=0), returns empty=true instead of URL
 */
export async function GET(request: NextRequest) {
  try {
    // Initialize services
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      return errorResponse("Not authenticated", "UNAUTHORIZED", 401);
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const storageName = searchParams.get("name");
    const storageType = searchParams.get("type");
    const versionId = searchParams.get("version");

    if (!storageName) {
      return errorResponse("Missing name parameter", "BAD_REQUEST", 400);
    }

    if (!storageType) {
      return errorResponse("Missing type parameter", "BAD_REQUEST", 400);
    }

    // Validate storage type
    if (storageType !== "volume" && storageType !== "artifact") {
      return errorResponse(
        "Invalid type. Must be 'volume' or 'artifact'",
        "BAD_REQUEST",
        400,
      );
    }

    log.debug(
      `Getting download URL for "${storageName}" (type: ${storageType})${versionId ? ` version ${versionId}` : ""} for user ${userId}`,
    );

    // Check if storage exists and belongs to user
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
      return errorResponse(
        `Storage "${storageName}" not found`,
        "NOT_FOUND",
        404,
      );
    }

    // Determine which version to download
    let version;
    if (versionId) {
      // Resolve version (supports short prefix)
      const resolveResult = await resolveVersionByPrefix(storage.id, versionId);
      if ("error" in resolveResult) {
        return errorResponse(
          resolveResult.error,
          resolveResult.status === 404 ? "NOT_FOUND" : "BAD_REQUEST",
          resolveResult.status,
        );
      }
      version = resolveResult.version;
    } else {
      // Use HEAD version
      if (!storage.headVersionId) {
        return errorResponse(
          `Storage "${storageName}" has no versions`,
          "NOT_FOUND",
          404,
        );
      }

      // Get HEAD version details
      const [headVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, storage.headVersionId))
        .limit(1);

      if (!headVersion) {
        return errorResponse(
          `Storage "${storageName}" HEAD version not found`,
          "NOT_FOUND",
          404,
        );
      }
      version = headVersion;
    }

    log.debug(`Generating presigned URL for version ${version.id}`);

    // Handle empty artifact case - return empty flag
    if (version.fileCount === 0) {
      log.debug("Empty artifact, returning empty response");
      return NextResponse.json({
        empty: true,
        versionId: version.id,
        fileCount: 0,
        size: 0,
      });
    }

    // Generate presigned URL for archive.tar.gz
    const bucketName = env().S3_USER_STORAGES_NAME;
    if (!bucketName) {
      return errorResponse(
        "S3_USER_STORAGES_NAME environment variable is not set",
        "INTERNAL_ERROR",
        500,
      );
    }

    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    // URL valid for 1 hour (3600 seconds)
    const url = await generatePresignedUrl(bucketName, archiveKey, 3600);

    log.debug(`Generated presigned URL for ${archiveKey}`);

    return NextResponse.json({
      url,
      versionId: version.id,
      fileCount: version.fileCount,
      size: Number(version.size),
    });
  } catch (error) {
    log.error("Download URL generation error:", error);

    return errorResponse(
      error instanceof Error
        ? error.message
        : "Failed to generate download URL",
      "INTERNAL_ERROR",
      500,
    );
  }
}
