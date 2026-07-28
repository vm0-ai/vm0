import { command } from "ccstate";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { env } from "../../lib/env";
import { badRequestMessage } from "../../lib/error";
import {
  buildArtifactKey,
  buildFileUrl,
  sanitizeArtifactFilename,
} from "../../lib/file-url";
import {
  isAllowedUploadType,
  MAX_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_SIZE_LABEL,
} from "../../lib/uploads-constants";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  abortMultipartS3Upload,
  createMultipartS3Upload,
  generatePresignedPutUrl,
  generatePresignedUploadPartUrl,
} from "../external/s3";
import { rejectSuspendedOrg$ } from "../services/zero-org-suspension.service";
import type { RouteEntry } from "../route-entry";
import { onRejection, tapError } from "../utils";

const PUT_URL_TTL_SECONDS = 3600;
const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;

const prepareUploadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);

    const bodyResult = await get(bodyResultOf(zeroUploadsContract.prepare));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { filename, size } = bodyResult.data;
    const contentType =
      bodyResult.data.contentType.split(";")[0]?.trim().toLowerCase() ?? "";

    if (size > MAX_UPLOAD_SIZE_BYTES) {
      return badRequestMessage(`File too large (max ${MAX_UPLOAD_SIZE_LABEL})`);
    }
    if (!isAllowedUploadType(contentType)) {
      return badRequestMessage(`Unsupported file type: ${contentType}`);
    }

    if (auth.orgId) {
      const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
      if (suspended) {
        return suspended;
      }
    }

    const id = crypto.randomUUID();
    const sanitizedName = sanitizeArtifactFilename(filename);
    const s3Key = buildArtifactKey(auth.userId, id, sanitizedName);
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const url = buildFileUrl(auth.userId, id, sanitizedName);

    if (
      bodyResult.data.multipart === true &&
      size >= MULTIPART_PART_SIZE_BYTES
    ) {
      let uploadId: string | undefined;
      return await onRejection(
        (async () => {
          uploadId = await get(
            createMultipartS3Upload(bucket, s3Key, contentType),
          );
          signal.throwIfAborted();
          const partCount = Math.ceil(size / MULTIPART_PART_SIZE_BYTES);
          const signedParts: {
            partNumber: number;
            uploadUrl: string;
          }[] = [];
          for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
            const uploadUrl = await get(
              generatePresignedUploadPartUrl(
                bucket,
                s3Key,
                uploadId,
                partNumber,
                PUT_URL_TTL_SECONDS,
              ),
            );
            signal.throwIfAborted();
            signedParts.push({ partNumber, uploadUrl });
          }
          return {
            status: 200 as const,
            body: {
              id,
              filename,
              contentType,
              size,
              url,
              multipart: {
                uploadId,
                partSize: MULTIPART_PART_SIZE_BYTES,
                parts: signedParts,
              },
            },
          };
        })(),
        async () => {
          if (uploadId !== undefined) {
            await tapError(
              get(abortMultipartS3Upload(bucket, s3Key, uploadId)),
            );
          }
        },
      );
    }

    const uploadUrl = await get(
      generatePresignedPutUrl(
        bucket,
        s3Key,
        contentType,
        PUT_URL_TTL_SECONDS,
        true,
      ),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { id, filename, contentType, size, uploadUrl, url },
    };
  },
);

export const zeroUploadsPrepareRoutes: readonly RouteEntry[] = [
  {
    route: zeroUploadsContract.prepare,
    handler: authRoute(
      { requiredCapability: "file:write" },
      prepareUploadInner$,
    ),
  },
];
