import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { generatePresignedUrl } from "../../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../../src/env";

/**
 * Permanent file URL resolver.
 *
 * Callers (chat messages, drafts, Slack unfurls, external share links) hold
 * a stable `/f/{userId}/{id}/{filename}` URL returned by
 * /api/zero/uploads/prepare. The three path segments rebuild the full S3
 * key (`uploads/{userId}/{id}/{filename}`) — the same convention the
 * prepare route uses — so this route needs no database or S3 listing to
 * resolve the object. It mints a short-lived presigned URL per request and
 * 302-redirects the browser.
 *
 * Access model: share-by-link. The path itself is the capability — any
 * caller that knows it may fetch the file, matching the semantics of the
 * previous 7-day presigned URLs. The 60-second Cache-Control lets the
 * browser reuse the redirect across immediate re-renders (image lazy-load,
 * scroll back into view) without re-hitting this route, while still forcing
 * a refresh well before the underlying presigned URL expires.
 *
 * Pass `?download=1` to force the browser to save instead of render inline.
 */

const SIGNED_TTL_SECONDS = 300;

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ userId: string; id: string; filename: string }> },
) {
  initServices();
  const { userId, id, filename } = await params;

  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  const s3Key = `uploads/${userId}/${id}/${filename}`;

  const wantDownload = request.nextUrl.searchParams.get("download") === "1";
  const signed = await generatePresignedUrl(
    bucket,
    s3Key,
    SIGNED_TTL_SECONDS,
    wantDownload ? filename : undefined,
    true,
  );

  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: signed,
      "Cache-Control": "private, max-age=60, must-revalidate",
    },
  });
}
