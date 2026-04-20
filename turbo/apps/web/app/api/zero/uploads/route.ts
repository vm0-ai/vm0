import { NextRequest, NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import {
  uploadS3Buffer,
  generatePresignedUrl,
} from "../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../src/env";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:zero:uploads");

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
]);

export async function POST(request: NextRequest) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
    { requiredCapability: "file:write" },
  );
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const userId = authCtx.userId;

  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: { message: "No file provided", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: { message: "File too large (max 10 MB)", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      {
        error: {
          message: `Unsupported file type: ${file.type}`,
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const id = crypto.randomUUID();
  const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const s3Key = `uploads/${userId}/${id}/${sanitizedName}`;
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;

  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadS3Buffer(bucket, s3Key, buffer, file.type);

  // Generate a presigned GET URL valid for 7 days (max SigV4 TTL)
  const url = await generatePresignedUrl(bucket, s3Key, 604800, sanitizedName);

  log.debug(
    `Uploaded ${sanitizedName} (${file.size} bytes) for user ${userId}`,
  );

  return NextResponse.json({
    id,
    filename: file.name,
    contentType: file.type,
    size: file.size,
    url,
  });
}
