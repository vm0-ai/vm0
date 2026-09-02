import { computed } from "ccstate";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

import { env } from "../../lib/env";
import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { generatePresignedGetUrl } from "../external/s3";
import { resolvedArtifactObject } from "../services/artifact-storage.service";
import type { RouteEntry } from "../route-entry";

// Long enough to cover a chat session without a reload, short enough to bound
// the exposure of a URL that grants read access on its own.
const FILE_URL_TTL_SECONDS = 2 * 60 * 60;

const fileUrlInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(queryOf(webFilesContract.fileUrl));

  const object = await get(resolvedArtifactObject(auth.userId, params.file_id));
  if (!object) {
    return notFound("File not found");
  }

  // Signed against the object key resolved for this user, so the URL never
  // widens beyond what the ownership check already allowed.
  const url = await get(
    generatePresignedGetUrl(
      env("R2_USER_ARTIFACTS_BUCKET_NAME"),
      object.key,
      FILE_URL_TTL_SECONDS,
      undefined,
      true,
    ),
  );

  // `object.url` addresses the same object on the public artifacts domain. It
  // carries no credential and does not expire, so it is the form to hand to
  // someone else; the presigned URL stays the one this browser renders from.
  return { status: 200 as const, body: { url, publicUrl: object.url } };
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
