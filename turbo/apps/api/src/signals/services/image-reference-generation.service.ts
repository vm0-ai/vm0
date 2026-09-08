import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { loadAccessibleImageReference } from "./image-reference-data.service";
import {
  privateArtifactRecord,
  privateArtifactsBucket,
} from "./private-artifact-storage.service";

const IMAGE_REFERENCE_PROVIDER_URL_TTL_SECONDS = 60 * 60;

type ImageReferenceGenerationAccessFailure =
  | { readonly kind: "disabled" }
  | { readonly kind: "not-found" };

interface AuthorizedImageReference {
  readonly kind: "authorized";
  readonly key: string;
  readonly referenceSource: "owner" | "organization";
}

export type ImageReferenceGenerationAccess =
  | ImageReferenceGenerationAccessFailure
  | AuthorizedImageReference;

export type ResolvedImageReferenceProviderUrl =
  | ImageReferenceGenerationAccessFailure
  | {
      readonly kind: "resolved";
      readonly url: string;
      readonly referenceSource: "owner" | "organization";
    };

function containsSensitiveMetadataError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    (error.message.startsWith("Image reference ") &&
      error.message.endsWith(" has invalid source metadata")) ||
    (error.message.startsWith("Private artifact ") &&
      (error.message.endsWith(" has incomplete storage metadata") ||
        error.message.endsWith(
          " does not match the configured private bucket",
        )))
  );
}

export const authorizeImageReferenceForGeneration$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly referenceId: string;
    },
    signal: AbortSignal,
  ): Promise<ImageReferenceGenerationAccess> => {
    const db = get(db$);
    const featureContext = await loadUserFeatureSwitchContext(
      db,
      args.orgId,
      args.userId,
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.ReferenceImages, featureContext)) {
      return { kind: "disabled" };
    }

    let reference;
    try {
      reference = await loadAccessibleImageReference(db, args);
    } catch (error) {
      signal.throwIfAborted();
      if (containsSensitiveMetadataError(error)) {
        return { kind: "not-found" };
      }
      throw error;
    }
    signal.throwIfAborted();
    if (!reference) {
      return { kind: "not-found" };
    }

    let source;
    try {
      source = await get(privateArtifactRecord(reference.sourceFileId));
    } catch (error) {
      signal.throwIfAborted();
      if (containsSensitiveMetadataError(error)) {
        return { kind: "not-found" };
      }
      throw error;
    }
    signal.throwIfAborted();
    if (
      !source ||
      source.userId !== reference.ownerUserId ||
      source.orgId !== args.orgId ||
      source.accessLevel !== "private" ||
      source.materializationStatus !== "ready" ||
      source.sizeBytes === null ||
      source.key !== reference.sourceStorageKey ||
      source.filename !== reference.sourceFilename ||
      source.contentType !== reference.sourceContentType
    ) {
      return { kind: "not-found" };
    }

    return {
      kind: "authorized",
      key: source.key,
      referenceSource:
        reference.ownerUserId === args.userId ? "owner" : "organization",
    };
  },
);

export const resolveImageReferenceProviderUrl$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly referenceId: string;
    },
    signal: AbortSignal,
  ): Promise<ResolvedImageReferenceProviderUrl> => {
    const access = await set(
      authorizeImageReferenceForGeneration$,
      args,
      signal,
    );
    if (access.kind !== "authorized") {
      return access;
    }

    const url = await get(
      generatePresignedGetUrl(
        privateArtifactsBucket(),
        access.key,
        IMAGE_REFERENCE_PROVIDER_URL_TTL_SECONDS,
        undefined,
        true,
      ),
    );
    signal.throwIfAborted();
    return {
      kind: "resolved",
      url,
      referenceSource: access.referenceSource,
    };
  },
);
