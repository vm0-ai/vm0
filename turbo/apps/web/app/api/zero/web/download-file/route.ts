import { NextResponse, type NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import {
  listS3Objects,
  downloadS3Buffer,
} from "../../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";
import { inferMimetype } from "../../../../../src/lib/shared/mimetype";

const log = logger("api:zero:web:download-file");

function errorResponse(
  status: number,
  message: string,
  code: string,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

/**
 * GET /api/zero/web/download-file?file_id=<id>
 *
 * Downloads a web-uploaded file from S3 and streams it to the caller.
 * Authenticates via ZERO_TOKEN with file:read capability (CLI PAT and Clerk
 * session bypass the capability check).
 * File ownership is enforced by S3 key structure: uploads/${userId}/${fileId}/...
 */
export async function GET(request: NextRequest): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await getAuthContext(authHeader, {
    requiredCapability: "file:read",
  });
  if (!authCtx) {
    return errorResponse(401, "Not authenticated", "UNAUTHORIZED");
  }

  const fileId = request.nextUrl.searchParams.get("file_id");
  if (!fileId) {
    return errorResponse(
      400,
      "file_id query parameter is required",
      "BAD_REQUEST",
    );
  }

  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  const prefix = `uploads/${authCtx.userId}/${fileId}/`;

  const objects = await listS3Objects(bucket, prefix);
  if (objects.length === 0) {
    return errorResponse(404, "File not found", "NOT_FOUND");
  }

  const s3Object = objects[0]!;
  const filename = s3Object.key.split("/").pop() ?? fileId;
  const mimetype = inferMimetype(filename);

  log.debug("Downloading web file", {
    fileId,
    key: s3Object.key,
    size: s3Object.size,
  });

  const buffer = await downloadS3Buffer(bucket, s3Object.key);

  const headers = new Headers();
  headers.set("Content-Type", mimetype);
  headers.set("X-File-Name", encodeURIComponent(filename));
  headers.set("X-File-Mimetype", mimetype);
  headers.set("Content-Length", String(buffer.length));

  return new Response(new Uint8Array(buffer), { status: 200, headers });
}
