import { command } from "ccstate";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { listS3Objects } from "../external/s3";
import { env } from "../../lib/env";
import { buildArtifactPrefix, buildFileUrl } from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { recordWebUploadedFile$ } from "../services/run-uploaded-files.service";
import type { RouteEntry } from "../route";

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

  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const prefix = buildArtifactPrefix(auth.userId, id);
  const objects = await get(listS3Objects(bucket, prefix));
  signal.throwIfAborted();
  if (objects.length === 0) {
    return {
      status: 404 as const,
      body: {
        error: { message: "Uploaded file not found", code: "NOT_FOUND" },
      },
    };
  }

  const s3Object = objects[0]!;
  const filename = s3Object.key.split("/").pop() ?? id;
  const contentType = requestedContentType ?? inferMimetype(filename);
  const size = s3Object.size;
  const url = buildFileUrl(auth.userId, id, filename);
  const lastModified =
    s3Object.lastModified instanceof Date
      ? s3Object.lastModified.toISOString()
      : undefined;

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
