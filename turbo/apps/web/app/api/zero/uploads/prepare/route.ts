import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { generatePresignedPutUrl } from "../../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_SIZE_LABEL,
} from "../../../../../src/lib/zero/uploads/constants";
import { buildFileUrl } from "../../../../../src/lib/zero/uploads/file-url";

const log = logger("api:zero:uploads:prepare");

/**
 * Presigned-URL upload preparation.
 *
 * Returns a presigned PUT URL so the browser (or CLI) uploads the file body
 * directly to R2. Because the body never passes through the Next.js runtime,
 * this path is not constrained by Vercel's ~4.5 MB serverless body cap.
 *
 * The GET-side URL returned to the caller is a permanent
 * `/f/{userId}/{id}/{filename}` redirect served by the app — callers may
 * persist it in messages, drafts, or external channels. The short-lived
 * presigned signature is materialized per-request inside that route, on
 * each individual access.
 */

const PUT_URL_TTL_SECONDS = 3600; // 1 hour to finish the upload

const prepareSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
});

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

  const parsed = prepareSchema.safeParse(
    await request.json().catch(() => {
      return null;
    }),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: { message: "Invalid request body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const { filename, size } = parsed.data;
  const contentType =
    parsed.data.contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (size > MAX_UPLOAD_SIZE_BYTES) {
    return NextResponse.json(
      {
        error: {
          message: `File too large (max ${MAX_UPLOAD_SIZE_LABEL})`,
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  if (!ALLOWED_UPLOAD_TYPES.has(contentType)) {
    return NextResponse.json(
      {
        error: {
          message: `Unsupported file type: ${contentType}`,
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const id = crypto.randomUUID();
  const sanitizedName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const s3Key = `uploads/${userId}/${id}/${sanitizedName}`;
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;

  const uploadUrl = await generatePresignedPutUrl(
    bucket,
    s3Key,
    contentType,
    PUT_URL_TTL_SECONDS,
    true,
  );
  const url = buildFileUrl(userId, id, sanitizedName);

  log.debug(
    `Prepared presigned upload for ${sanitizedName} (${size} bytes) user=${userId}`,
  );

  return NextResponse.json({
    id,
    filename,
    contentType,
    size,
    uploadUrl,
    url,
  });
}
