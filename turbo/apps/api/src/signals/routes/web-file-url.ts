import { nowDate } from "../../lib/time";
import { command } from "ccstate";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { generateArtifactPreviewUrl } from "../external/s3";
import { PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS } from "../../lib/private-artifact-preview";
import { uploadedArtifactObject } from "../services/uploaded-artifact.service";
import type { RouteEntry } from "../route-entry";

// Long enough to cover a chat session without a reload, short enough to bound
// the exposure of a URL that grants read access on its own.
const FILE_URL_TTL_SECONDS = 2 * 60 * 60;

const fileUrlInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(queryOf(webFilesContract.fileUrl));

  const object = await get(
    uploadedArtifactObject({
      userId: auth.userId,
      orgId: auth.orgId,
      id: params.file_id,
    }),
  );
  signal.throwIfAborted();
  if (!object) {
    return notFound("File not found");
  }

  // Signed against the object key resolved for this user, so the URL never
  // widens beyond what the ownership check already allowed.
  const preview = await get(
    generateArtifactPreviewUrl(object.bucket, object.key, {
      expiresIn: object.isPrivate
        ? PRIVATE_ARTIFACT_PREVIEW_TTL_SECONDS
        : FILE_URL_TTL_SECONDS,
      signingDate: nowDate(),
    }),
  );

  signal.throwIfAborted();
  if (object.isPrivate) {
    set(setResHeader$, "Cache-Control", "private, no-store");
  }
  return {
    status: 200 as const,
    body: { ...preview, publicUrl: object.isPrivate ? null : object.url },
  };
});

export const webFileUrlRoutes: readonly RouteEntry[] = [
  {
    route: webFilesContract.fileUrl,
    handler: authRoute(
      {
        requireOrganization: false,
        missingOrganizationStatus: 401,
        requiredCapability: "file:read",
      },
      fileUrlInner$,
    ),
  },
];
