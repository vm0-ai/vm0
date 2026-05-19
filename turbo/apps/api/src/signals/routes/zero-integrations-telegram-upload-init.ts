import { command } from "ccstate";
import { integrationsTelegramUploadInitContract } from "@vm0/api-contracts/contracts/integrations";

import { env } from "../../lib/env";
import { buildArtifactKey, buildFileUrl } from "../../lib/file-url";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { generatePresignedPutUrl } from "../external/s3";
import type { RouteEntry } from "../route";

const PUT_URL_TTL_SECONDS = 3600;

const initInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);

  const bodyResult = await get(
    bodyResultOf(integrationsTelegramUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { filename, contentType, length } = bodyResult.data;
  const uploadId = crypto.randomUUID();
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const s3Key = buildArtifactKey(auth.userId, uploadId, sanitized);
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const uploadUrl = await get(
    generatePresignedPutUrl(bucket, s3Key, contentType, PUT_URL_TTL_SECONDS),
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      uploadId,
      uploadUrl,
      fileUrl: buildFileUrl(auth.userId, uploadId, sanitized),
      filename: sanitized,
      contentType,
      size: length,
    },
  };
});

export const zeroIntegrationsTelegramUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTelegramUploadInitContract.init,
    handler: authRoute({ requiredCapability: "telegram:write" }, initInner$),
  },
];
