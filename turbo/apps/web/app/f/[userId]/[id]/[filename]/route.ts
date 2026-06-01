import { NextRequest, NextResponse } from "next/server";
import {
  generatePresignedUrl,
  s3ObjectExists,
} from "../../../../../src/lib/infra/s3/s3-client";
import {
  buildArtifactKey,
  buildFileUrl,
  storageUserIdFromFileUrlSegment,
} from "../../../../../src/lib/zero/uploads/file-url";
import { env } from "../../../../../src/env";
import { applyCorsHeaders } from "../../../../../proxy.cors";

/**
 * Legacy permanent file URL resolver.
 *
 * New uploads return CDN URLs directly. This route keeps old
 * `/f/{userIdSegment}/{id}/{filename}` links alive by redirecting to the new
 * public artifact CDN when the migrated object exists. If the artifact object
 * is absent, it falls back to the old user-storage presigned URL convention.
 *
 * Access model: share-by-link. The path itself is the capability — any
 * caller that knows it may fetch the file, matching the semantics of public
 * CDN artifact links.
 */

const SIGNED_TTL_SECONDS = 300;

export function OPTIONS(request: NextRequest) {
  return applyCorsHeaders(
    request,
    new NextResponse(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers":
          "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, Range",
        "Access-Control-Max-Age": "86400",
      },
    }),
  );
}

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ userId: string; id: string; filename: string }> },
) {
  const { userId, id, filename } = await params;
  const storageUserId = storageUserIdFromFileUrlSegment(userId);

  const artifactBucket = env().R2_USER_ARTIFACTS_BUCKET_NAME;
  const artifactKey = buildArtifactKey(storageUserId, id, filename);
  const artifactUrl = buildFileUrl(storageUserId, id, filename);

  if (await s3ObjectExists(artifactBucket, artifactKey)) {
    return applyCorsHeaders(
      request,
      new NextResponse(null, {
        status: 302,
        headers: {
          Location: artifactUrl,
          "Cache-Control": "public, max-age=300, must-revalidate",
        },
      }),
    );
  }

  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  const s3Key = `uploads/${storageUserId}/${id}/${filename}`;
  const signed = await generatePresignedUrl(
    bucket,
    s3Key,
    SIGNED_TTL_SECONDS,
    undefined,
    true,
  );

  return applyCorsHeaders(
    request,
    new NextResponse(null, {
      status: 302,
      headers: {
        Location: signed,
        "Cache-Control": "private, max-age=60, must-revalidate",
      },
    }),
  );
}
