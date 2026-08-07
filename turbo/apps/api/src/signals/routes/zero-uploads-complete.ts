import { command } from "ccstate";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { resolveArtifactObject$ } from "../services/artifact-storage.service";
import { recordWebUploadedFile$ } from "../services/run-uploaded-files.service";
import { rejectSuspendedOrg$ } from "../services/zero-org-suspension.service";
import type { RouteEntry } from "../route-entry";

const completeBody$ = bodyResultOf(zeroUploadsContract.complete);

const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const body = await get(completeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return {
      status: 400 as const,
      body: {
        error: { message: "Invalid request body", code: "BAD_REQUEST" },
      },
    };
  }

  const { id, contentType: requestedContentType } = body.data;

  if (requestedContentType && !isAllowedUploadType(requestedContentType)) {
    return {
      status: 400 as const,
      body: {
        error: {
          message: `Unsupported file type: ${requestedContentType}`,
          code: "BAD_REQUEST",
        },
      },
    };
  }

  if (auth.orgId) {
    const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
    if (suspended) {
      return suspended;
    }
  }

  const s3Object = await set(
    resolveArtifactObject$,
    { userId: auth.userId, id },
    signal,
  );
  if (!s3Object) {
    return {
      status: 404 as const,
      body: {
        error: { message: "Uploaded file not found", code: "NOT_FOUND" },
      },
    };
  }

  const filename = s3Object.filename;
  const contentType = requestedContentType ?? s3Object.contentType;
  const size = s3Object.size;
  const url = s3Object.url;
  const lastModified = s3Object.lastModified?.toISOString();

  const runId = "runId" in auth ? auth.runId : undefined;

  await set(
    recordWebUploadedFile$,
    {
      runId,
      externalId: id,
      userId: auth.userId,
      orgId: "orgId" in auth ? auth.orgId : null,
      filename,
      contentType,
      sizeBytes: size,
      url,
      s3Key: s3Object.key,
      metadata: lastModified ? { lastModified } : {},
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { id, filename, contentType, size, url },
  };
});

export const zeroUploadsCompleteRoutes: readonly RouteEntry[] = [
  {
    route: zeroUploadsContract.complete,
    handler: authRoute({ requiredCapability: "file:write" }, completeInner$),
  },
];
