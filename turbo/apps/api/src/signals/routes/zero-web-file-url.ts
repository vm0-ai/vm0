import { computed } from "ccstate";
import { zeroWebFilesContract } from "@vm0/api-contracts/contracts/zero-web-files";

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
  const params = get(queryOf(zeroWebFilesContract.fileUrl));

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

  return { status: 200 as const, body: { url } };
});

export const zeroWebFileUrlRoutes: readonly RouteEntry[] = [
  {
    route: zeroWebFilesContract.fileUrl,
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
