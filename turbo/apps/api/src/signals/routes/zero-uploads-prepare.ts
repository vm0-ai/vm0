import { command } from "ccstate";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { env } from "../../lib/env";
import { badRequestMessage } from "../../lib/error";
import { buildFileUrl } from "../../lib/file-url";
import {
  isAllowedUploadType,
  MAX_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_SIZE_LABEL,
} from "../../lib/uploads-constants";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { generatePresignedPutUrl } from "../external/s3";
import type { RouteEntry } from "../route";

const PUT_URL_TTL_SECONDS = 3600;

const prepareUploadInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);

  const bodyResult = await get(bodyResultOf(zeroUploadsContract.prepare));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { filename, size } = bodyResult.data;
  const contentType =
    bodyResult.data.contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (size > MAX_UPLOAD_SIZE_BYTES) {
    return badRequestMessage(`File too large (max ${MAX_UPLOAD_SIZE_LABEL})`);
  }
  if (!isAllowedUploadType(contentType)) {
    return badRequestMessage(`Unsupported file type: ${contentType}`);
  }

  const id = crypto.randomUUID();
  const sanitizedName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const s3Key = `uploads/${auth.userId}/${id}/${sanitizedName}`;
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");

  const uploadUrl = await get(
    generatePresignedPutUrl(
      bucket,
      s3Key,
      contentType,
      PUT_URL_TTL_SECONDS,
      true,
    ),
  );
  signal.throwIfAborted();
  const url = buildFileUrl(auth.userId, id, sanitizedName);

  return {
    status: 200 as const,
    body: { id, filename, contentType, size, uploadUrl, url },
  };
});

export const zeroUploadsPrepareRoutes: readonly RouteEntry[] = [
  {
    route: zeroUploadsContract.prepare,
    handler: authRoute(
      { requiredCapability: "file:write" },
      prepareUploadInner$,
    ),
  },
];
