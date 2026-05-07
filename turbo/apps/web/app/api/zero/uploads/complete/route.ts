import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { listS3Objects } from "../../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../../src/env";
import { inferMimetype } from "../../../../../src/lib/shared/mimetype";
import { buildFileUrl } from "../../../../../src/lib/zero/uploads/file-url";
import { recordWebUploadedFile } from "../../../../../src/lib/zero/uploads/run-uploaded-files";
import { logger } from "../../../../../src/lib/shared/logger";
import { ALLOWED_UPLOAD_TYPES } from "../../../../../src/lib/zero/uploads/constants";

const log = logger("api:zero:uploads:complete");

const completeSchema = z.object({
  id: z.string().uuid(),
  contentType: z.string().min(1).max(200).optional(),
});

function errorResponse(
  status: number,
  message: string,
  code: string,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

export async function POST(request: NextRequest) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
    { requiredCapability: "file:write" },
  );
  if (!authCtx) {
    return errorResponse(401, "Not authenticated", "UNAUTHORIZED");
  }

  const parsed = completeSchema.safeParse(
    await request.json().catch(() => {
      return null;
    }),
  );
  if (!parsed.success) {
    return errorResponse(400, "Invalid request body", "BAD_REQUEST");
  }

  const { id, contentType: requestedContentType } = parsed.data;
  if (requestedContentType && !ALLOWED_UPLOAD_TYPES.has(requestedContentType)) {
    return errorResponse(
      400,
      `Unsupported file type: ${requestedContentType}`,
      "BAD_REQUEST",
    );
  }

  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  const prefix = `uploads/${authCtx.userId}/${id}/`;
  const objects = await listS3Objects(bucket, prefix);
  if (objects.length === 0) {
    return errorResponse(404, "Uploaded file not found", "NOT_FOUND");
  }

  const s3Object = objects[0]!;
  const filename = s3Object.key.split("/").pop() ?? id;
  const contentType = requestedContentType ?? inferMimetype(filename);
  const size = s3Object.size;
  const url = buildFileUrl(authCtx.userId, id, filename);
  const lastModified =
    "lastModified" in s3Object && s3Object.lastModified instanceof Date
      ? s3Object.lastModified.toISOString()
      : undefined;

  await recordWebUploadedFile({
    runId: authCtx.runId,
    externalId: id,
    userId: authCtx.userId,
    orgId: authCtx.orgId,
    filename,
    contentType,
    sizeBytes: size,
    url,
    s3Key: s3Object.key,
    metadata: {
      ...(lastModified ? { lastModified } : {}),
    },
  });

  log.debug("Completed web upload", {
    id,
    key: s3Object.key,
    size,
    hasRunId: Boolean(authCtx.runId),
  });

  return NextResponse.json({
    id,
    filename,
    contentType,
    size,
    url,
  });
}
