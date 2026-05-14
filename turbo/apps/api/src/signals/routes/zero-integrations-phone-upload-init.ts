import { command } from "ccstate";
import { integrationsPhoneUploadInitContract } from "@vm0/api-contracts/contracts/integrations";

import { env } from "../../lib/env";
import { buildFileUrl } from "../../lib/file-url";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { generatePresignedPutUrl } from "../external/s3";
import type { RouteEntry } from "../route";

const PUT_URL_TTL_SECONDS = 3600;

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

const init$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsPhoneUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const uploadId = crypto.randomUUID();
  const filename = sanitizeFilename(body.filename);
  const s3Key = `uploads/${auth.userId}/${uploadId}/${filename}`;
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const uploadUrl = await get(
    generatePresignedPutUrl(
      bucket,
      s3Key,
      body.contentType,
      PUT_URL_TTL_SECONDS,
      true,
    ),
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      uploadId,
      uploadUrl,
      fileUrl: buildFileUrl(auth.userId, uploadId, filename),
      filename,
      contentType: body.contentType,
      size: body.length,
    },
  };
});

export const zeroIntegrationsPhoneUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsPhoneUploadInitContract.init,
    handler: authRoute({ requiredCapability: "phone:write" }, init$),
  },
];
