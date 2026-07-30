import { command } from "ccstate";
import { integrationsGithubUploadInitContract } from "@vm0/api-contracts/contracts/integrations";

import { env } from "../../lib/env";
import { sanitizeArtifactFilename } from "../../lib/file-url";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { generatePresignedPutUrl, s3MetadataHeaders } from "../external/s3";
import { allocateArtifactObject$ } from "../services/artifact-storage.service";
import type { RouteEntry } from "../route-entry";

const PUT_URL_TTL_SECONDS = 3600;

const init$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsGithubUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const filename = sanitizeArtifactFilename(body.filename);
  const artifact = await set(
    allocateArtifactObject$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      filename: body.filename,
      allowV2: body.supportsUploadHeaders === true,
    },
    signal,
  );
  const uploadHeaders = artifact.metadata
    ? s3MetadataHeaders(artifact.metadata)
    : undefined;
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
      ...(uploadHeaders ? { uploadHeaders } : {}),
    },
  };
});

const githubWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "github:write",
} as const;

export const zeroIntegrationsGithubUploadInitRoutes: readonly RouteEntry[] = [
  {
    route: integrationsGithubUploadInitContract.init,
    handler: authRoute(githubWriteAuth, init$),
  },
];
