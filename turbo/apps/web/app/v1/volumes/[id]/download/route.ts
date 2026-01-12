/**
 * Public API v1 - Volume Download Endpoint
 *
 * GET /v1/volumes/:id/download - Redirect to presigned URL for tar.gz archive
 */
import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../../src/lib/public-api/auth";
import {
  storages,
  storageVersions,
} from "../../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { generatePresignedUrl } from "../../../../../src/lib/s3/s3-client";
import { resolveVersionByPrefix } from "../../../../../src/lib/storage/version-resolver";
import { env } from "../../../../../src/env";

const STORAGE_TYPE = "volume";
const DOWNLOAD_EXPIRY_SECONDS = 3600; // 1 hour

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const versionId = searchParams.get("version_id") ?? undefined;

  const auth = await authenticatePublicApi();
  if (!isAuthSuccess(auth)) {
    return NextResponse.json(
      {
        error: {
          type: "authentication_error",
          code: "invalid_api_key",
          message: "Invalid API key provided",
        },
      },
      { status: 401 },
    );
  }

  // Verify volume exists and belongs to user
  const [volume] = await globalThis.services.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.id, id),
        eq(storages.userId, auth.userId),
        eq(storages.type, STORAGE_TYPE),
      ),
    )
    .limit(1);

  if (!volume) {
    return NextResponse.json(
      {
        error: {
          type: "not_found_error",
          code: "resource_not_found",
          message: `No such volume: '${id}'`,
        },
      },
      { status: 404 },
    );
  }

  // Determine which version to download
  let version;
  if (versionId) {
    // Resolve version (supports short prefix)
    const resolveResult = await resolveVersionByPrefix(volume.id, versionId);
    if ("error" in resolveResult) {
      return NextResponse.json(
        {
          error: {
            type: "not_found_error",
            code: "resource_not_found",
            message: resolveResult.error,
          },
        },
        { status: 404 },
      );
    }
    version = resolveResult.version;
  } else {
    // Use HEAD version
    if (!volume.headVersionId) {
      return NextResponse.json(
        {
          error: {
            type: "not_found_error",
            code: "resource_not_found",
            message: `Volume '${volume.name}' has no versions`,
          },
        },
        { status: 404 },
      );
    }

    const [headVersion] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(eq(storageVersions.id, volume.headVersionId))
      .limit(1);

    if (!headVersion) {
      return NextResponse.json(
        {
          error: {
            type: "not_found_error",
            code: "resource_not_found",
            message: `Volume '${volume.name}' HEAD version not found`,
          },
        },
        { status: 404 },
      );
    }
    version = headVersion;
  }

  // Get bucket name
  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
  if (!bucketName) {
    return NextResponse.json(
      {
        error: {
          type: "api_error",
          code: "internal_error",
          message: "Storage service not configured",
        },
      },
      { status: 500 },
    );
  }

  // Handle empty volume case
  if (version.fileCount === 0) {
    return NextResponse.json(
      {
        error: {
          type: "not_found_error",
          code: "resource_not_found",
          message: `Volume '${volume.name}' version has no files`,
        },
      },
      { status: 404 },
    );
  }

  // Generate presigned URL for archive download
  const archiveKey = `${version.s3Key}/archive.tar.gz`;
  const archiveUrl = await generatePresignedUrl(
    bucketName,
    archiveKey,
    DOWNLOAD_EXPIRY_SECONDS,
  );

  // Return 302 redirect to presigned URL
  return NextResponse.redirect(archiveUrl, 302);
}
