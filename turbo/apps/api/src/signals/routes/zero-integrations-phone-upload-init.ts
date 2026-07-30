import { command } from "ccstate";
import { integrationsPhoneUploadInitContract } from "@vm0/api-contracts/contracts/integrations";

import { env } from "../../lib/env";
import { sanitizeArtifactFilename } from "../../lib/file-url";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { generatePresignedPutUrl } from "../external/s3";
import { allocateArtifactObject$ } from "../services/artifact-storage.service";
import type { RouteEntry } from "../route-entry";

const PUT_URL_TTL_SECONDS = 3600;

const init$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsPhoneUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const filename = sanitizeArtifactFilename(body.filename);
  const artifact = await set(
    allocateArtifactObject$,
    { userId: auth.userId, orgId: auth.orgId, filename: body.filename },
    signal,
  );
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const uploadUrl = await get(
    generatePresignedPutUrl(
      bucket,
      artifact.key,
      body.contentType,
      PUT_URL_TTL_SECONDS,
      { usePublicEndpoint: true, metadata: artifact.metadata },
    ),
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      uploadId: artifact.id,
      uploadUrl,
      fileUrl: artifact.url,
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
