import { command } from "ccstate";
import {
  IMAGE_REFERENCE_CONTENT_TYPES,
  MAX_IMAGE_REFERENCE_SOURCE_BYTES,
} from "@okouai/api-contracts/contracts/image-references";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { badRequestMessage } from "../../lib/error";
import {
  MAX_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_SIZE_LABEL,
  normalizeWebUploadContentType,
} from "../../lib/uploads-constants";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, type ReadonlyDb } from "../external/db";
import {
  abortMultipartS3Upload,
  createMultipartS3Upload,
  generatePresignedPutUrl,
  generatePresignedUploadPartUrl,
  s3MetadataHeaders,
} from "../external/s3";
import { allocateUploadedArtifact$ } from "../services/uploaded-artifact.service";
import { rejectSuspendedOrg$ } from "../services/org-suspension.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";
import { onRejection, tapError } from "../utils";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const PUT_URL_TTL_SECONDS = 3600;
const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
const imageReferencesDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Reference images are not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

async function imageReferenceUploadRejection(
  db: ReadonlyDb,
  args: {
    readonly orgId: string | undefined;
    readonly userId: string;
    readonly purpose: "artifact" | "image-reference" | undefined;
    readonly contentType: string;
    readonly size: number;
  },
  signal: AbortSignal,
) {
  if (args.purpose !== "image-reference") {
    return null;
  }
  if (!args.orgId) {
    return badRequestMessage("Image reference uploads require an organization");
  }
  const featureContext = await loadUserFeatureSwitchContext(
    db,
    args.orgId,
    args.userId,
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.ReferenceImages, featureContext)) {
    return imageReferencesDisabled;
  }
  const acceptedContentTypes: readonly string[] = IMAGE_REFERENCE_CONTENT_TYPES;
  if (!acceptedContentTypes.includes(args.contentType)) {
    return badRequestMessage(
      `Reference images must be one of: ${acceptedContentTypes.join(", ")}`,
    );
  }
  return args.size > MAX_IMAGE_REFERENCE_SOURCE_BYTES
    ? badRequestMessage(
        `Reference images must be ${MAX_IMAGE_REFERENCE_SOURCE_BYTES.toString()} bytes or smaller`,
      )
    : null;
}

const prepareUploadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);

    const bodyResult = await get(bodyResultOf(uploadsContract.prepare));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { filename, size } = bodyResult.data;
    const contentType = normalizeWebUploadContentType(
      bodyResult.data.contentType,
    );

    const imageReferenceRejection = await imageReferenceUploadRejection(
      get(db$),
      {
        orgId: auth.orgId,
        userId: auth.userId,
        purpose: bodyResult.data.purpose,
        contentType,
        size,
      },
      signal,
    );
    if (imageReferenceRejection) {
      return imageReferenceRejection;
    }

    if (size > MAX_UPLOAD_SIZE_BYTES) {
      return badRequestMessage(`File too large (max ${MAX_UPLOAD_SIZE_LABEL})`);
    }
    if (auth.orgId) {
      const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
      if (suspended) {
        return suspended;
      }
    }

    const artifact = await set(
      allocateUploadedArtifact$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        filename,
        contentType,
        size,
        publicBrand: PUBLIC_BRAND,
        purpose: bodyResult.data.purpose,
      },
      signal,
    );
    const bucket = artifact.bucket;
    const { id, key: s3Key, url, metadata } = artifact;
    const uploadHeaders = s3MetadataHeaders(metadata);

    if (
      bodyResult.data.multipart === true &&
      size >= MULTIPART_PART_SIZE_BYTES
    ) {
      let uploadId: string | undefined;
      return await onRejection(
        (async () => {
          uploadId = await get(
            createMultipartS3Upload(bucket, s3Key, contentType, metadata),
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
      generatePresignedPutUrl(bucket, s3Key, contentType, PUT_URL_TTL_SECONDS, {
        usePublicEndpoint: true,
        metadata,
      }),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        id,
        filename,
        contentType,
        size,
        uploadUrl,
        url,
        ...(uploadHeaders ? { uploadHeaders } : {}),
      },
    };
  },
);

export const uploadsPrepareRoutes: readonly RouteEntry[] = [
  {
    route: uploadsContract.prepare,
    handler: authRoute(
      { requiredCapability: "file:write" },
      prepareUploadInner$,
    ),
  },
];
