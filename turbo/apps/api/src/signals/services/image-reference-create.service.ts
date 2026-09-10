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
  type S3ObjectHead,
} from "../external/s3";
import { settle } from "../utils";
import {
  IMAGE_REFERENCE_EXCLUSIVE_OWNER,
  privateArtifactRecord,
  type PrivateArtifactExclusiveOwner,
} from "./private-artifact-storage.service";

type CreateImageReferenceResult =
  | { readonly kind: "created"; readonly referenceId: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "rejected"; readonly message: string };

type SourceCandidate = {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly accessLevel: string | null;
  readonly materializationStatus: string | null;
  readonly sizeBytes: number | null;
  readonly contentType: string;
  readonly bucket: string;
  readonly key: string;
  readonly exclusiveOwner?: PrivateArtifactExclusiveOwner;
};

/**
 * Only an upload allocated by this feature's own prepare endpoint qualifies.
 * A catalog entry owns its source object's lifetime, so adopting an artifact
 * the user created for something else would let a later catalog deletion
 * destroy that artifact and everything already pointing at it.
 */
function isOwnedReadyPrivateSource(
  source: SourceCandidate | null,
  args: { readonly ownerUserId: string; readonly orgId: string },
): source is SourceCandidate & { readonly sizeBytes: number } {
  return (
    source !== null &&
    source.userId === args.ownerUserId &&
    source.orgId === args.orgId &&
    source.accessLevel === "private" &&
    source.materializationStatus === "ready" &&
    source.exclusiveOwner === IMAGE_REFERENCE_EXCLUSIVE_OWNER &&
    source.sizeBytes !== null
  );
}

function storedObjectMetadataMatches(
  source: SourceCandidate & { readonly sizeBytes: number },
  head: Extract<S3ObjectHead, { readonly kind: "found" }>,
): head is Extract<S3ObjectHead, { readonly kind: "found" }> & {
  readonly contentLength: number;
} {
  return (
    head.contentLength !== undefined &&
    head.contentLength === source.sizeBytes &&
    head.metadata["artifact-id"] === source.id
  );
}

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
    if (!isOwnedReadyPrivateSource(source, args)) {
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
    if (!storedObjectMetadataMatches(source, head)) {
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
