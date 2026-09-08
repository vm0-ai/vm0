import {
  IMAGE_REFERENCE_CONTENT_TYPES,
  MAX_IMAGE_REFERENCE_DIMENSION,
  MAX_IMAGE_REFERENCE_PIXELS,
  MAX_IMAGE_REFERENCE_SOURCE_BYTES,
  type CreateImageReferenceBody,
} from "@okouai/api-contracts/contracts/image-references";
import { imageReferences } from "@okouai/db/schema/image-reference";
import { command } from "ccstate";

import { parseImageReferenceMetadata } from "../../lib/image-reference-metadata";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  S3ObjectSizeLimitError,
  s3ObjectHead,
} from "../external/s3";
import { settle } from "../utils";
import { privateArtifactRecord } from "./private-artifact-storage.service";

type CreateImageReferenceResult =
  | { readonly kind: "created"; readonly referenceId: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "rejected"; readonly message: string };

function invalidDimensions(width: number, height: number): boolean {
  return (
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_REFERENCE_DIMENSION ||
    height > MAX_IMAGE_REFERENCE_DIMENSION ||
    width * height > MAX_IMAGE_REFERENCE_PIXELS
  );
}

export const createImageReference$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly body: CreateImageReferenceBody;
    },
    signal: AbortSignal,
  ): Promise<CreateImageReferenceResult> => {
    const source = await get(privateArtifactRecord(args.body.sourceFileId));
    signal.throwIfAborted();
    if (
      !source ||
      source.userId !== args.ownerUserId ||
      source.orgId !== args.orgId ||
      source.accessLevel !== "private" ||
      source.materializationStatus !== "ready" ||
      source.sizeBytes === null
    ) {
      return { kind: "rejected", message: "Uploaded file not found" };
    }

    const acceptedContentTypes: readonly string[] =
      IMAGE_REFERENCE_CONTENT_TYPES;
    if (!acceptedContentTypes.includes(source.contentType)) {
      return {
        kind: "rejected",
        message: `Reference images must be one of: ${acceptedContentTypes.join(", ")}`,
      };
    }

    const head = await get(s3ObjectHead(source.bucket, source.key));
    signal.throwIfAborted();
    if (head.kind === "missing") {
      return { kind: "rejected", message: "Uploaded file not found" };
    }
    if (
      head.contentLength === undefined ||
      head.contentLength !== source.sizeBytes ||
      head.metadata["artifact-id"] !== source.id
    ) {
      return {
        kind: "rejected",
        message: "Uploaded file metadata does not match the stored object",
      };
    }
    if (head.contentLength > MAX_IMAGE_REFERENCE_SOURCE_BYTES) {
      return {
        kind: "rejected",
        message: `Reference images must be ${MAX_IMAGE_REFERENCE_SOURCE_BYTES.toString()} bytes or smaller`,
      };
    }

    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          source.bucket,
          source.key,
          MAX_IMAGE_REFERENCE_SOURCE_BYTES,
          signal,
        ),
      ),
      signal,
    );
    if (!downloaded.ok) {
      if (downloaded.error instanceof S3ObjectSizeLimitError) {
        return {
          kind: "rejected",
          message: `Reference images must be ${MAX_IMAGE_REFERENCE_SOURCE_BYTES.toString()} bytes or smaller`,
        };
      }
      throw downloaded.error;
    }

    const metadata = parseImageReferenceMetadata(downloaded.value);
    if (!metadata) {
      return {
        kind: "rejected",
        message: "The uploaded file is not a valid PNG, JPEG, or WebP image",
      };
    }
    if (
      metadata.contentType !== source.contentType ||
      (head.contentType !== undefined &&
        metadata.contentType !== head.contentType)
    ) {
      return {
        kind: "rejected",
        message: "The uploaded image bytes do not match its content type",
      };
    }
    if (invalidDimensions(metadata.width, metadata.height)) {
      return {
        kind: "rejected",
        message: `Reference image dimensions must be positive, no larger than ${MAX_IMAGE_REFERENCE_DIMENSION.toString()}px per edge, and no more than ${MAX_IMAGE_REFERENCE_PIXELS.toString()} total pixels`,
      };
    }

    const currentTime = nowDate();
    const [created] = await set(writeDb$)
      .insert(imageReferences)
      .values({
        orgId: args.orgId,
        ownerUserId: args.ownerUserId,
        sourceFileId: source.id,
        title: args.body.title,
        visibility: args.body.visibility,
        width: metadata.width,
        height: metadata.height,
        createdBy: args.ownerUserId,
        updatedBy: args.ownerUserId,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .onConflictDoNothing({ target: imageReferences.sourceFileId })
      .returning({ id: imageReferences.id });
    signal.throwIfAborted();
    return created
      ? { kind: "created", referenceId: created.id }
      : { kind: "conflict" };
  },
);
