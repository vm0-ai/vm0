import { command } from "ccstate";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { env } from "../../lib/env";
import { badRequestMessage } from "../../lib/error";
import {
  buildArtifactKey,
  buildFileUrl,
  sanitizeArtifactFilename,
} from "../../lib/file-url";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  abortMultipartS3Upload,
  completeMultipartS3Upload,
  listMultipartS3Parts,
} from "../external/s3";
import { rejectSuspendedOrg$ } from "../services/zero-org-suspension.service";
import type { RouteEntry } from "../route-entry";

const completeMultipartInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const bodyResult = await get(
      bodyResultOf(zeroUploadsContract.completeMultipart),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    if (auth.orgId) {
      const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
      if (suspended) {
        return suspended;
      }
    }

    const { id, filename, uploadId, partCount } = bodyResult.data;
    const sanitizedName = sanitizeArtifactFilename(filename);
    const key = buildArtifactKey(auth.userId, id, sanitizedName);
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const parts = await get(listMultipartS3Parts(bucket, key, uploadId));
    signal.throwIfAborted();
    const completePartSet =
      parts.length === partCount &&
      parts.every((part, index) => {
        return part.partNumber === index + 1;
      });
    if (!completePartSet) {
      return badRequestMessage("Multipart upload is incomplete");
    }

    await get(completeMultipartS3Upload(bucket, key, uploadId, parts));
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        id,
        url: buildFileUrl(auth.userId, id, sanitizedName),
      },
    };
  },
);

const abortMultipartInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const bodyResult = await get(
    bodyResultOf(zeroUploadsContract.abortMultipart),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const { id, filename, uploadId } = bodyResult.data;
  const key = buildArtifactKey(
    auth.userId,
    id,
    sanitizeArtifactFilename(filename),
  );
  await get(
    abortMultipartS3Upload(env("R2_USER_ARTIFACTS_BUCKET_NAME"), key, uploadId),
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { id },
  };
});

export const zeroUploadsMultipartRoutes: readonly RouteEntry[] = [
  {
    route: zeroUploadsContract.completeMultipart,
    handler: authRoute(
      { requiredCapability: "file:write" },
      completeMultipartInner$,
    ),
  },
  {
    route: zeroUploadsContract.abortMultipart,
    handler: authRoute(
      { requiredCapability: "file:write" },
      abortMultipartInner$,
    ),
  },
];
