import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { env } from "../../lib/env";
import {
  buildArtifactKey,
  buildArtifactKeyV2,
  buildArtifactPrefix,
  buildArtifactPrefixV2,
  buildFileUrlFromKey,
  sanitizeArtifactFilename,
} from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import {
  listS3Objects,
  putS3Object,
  s3ObjectHead,
  tryListMultipartS3Parts,
} from "../external/s3";
import { safeUriComponentDecode } from "../utils";

const MAX_ARTIFACT_KEY_ATTEMPTS = 5;
const ARTIFACT_ID_METADATA_KEY = "artifact-id";
const ARTIFACT_FILENAME_METADATA_KEY = "filename";
const ARTIFACT_USER_ID_METADATA_KEY = "user-id";
const ARTIFACT_PUBLIC_BRAND_METADATA_KEY = "public-brand";

export interface ArtifactObjectLocation {
  readonly id: string;
  readonly key: string;
  readonly url: string;
  readonly metadata: Readonly<Record<string, string>>;
}

type StoredGeneratedArtifactObject = Omit<
  ArtifactObjectLocation,
  "metadata"
> & {
  readonly filename: string;
  readonly metadata: Readonly<Record<string, string>>;
};

export interface ResolvedArtifactObject {
  readonly key: string;
  readonly url: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly lastModified: Date | undefined;
}

interface ResolvedArtifactMultipartUpload {
  readonly key: string;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
  }[];
}

export function artifactObjectMetadata(
  userId: string,
  id: string,
  filename: string,
  publicBrand: PublicBrand,
): Readonly<Record<string, string>> {
  return {
    [ARTIFACT_ID_METADATA_KEY]: id,
    [ARTIFACT_FILENAME_METADATA_KEY]: encodeURIComponent(filename),
    [ARTIFACT_USER_ID_METADATA_KEY]: encodeURIComponent(userId),
    [ARTIFACT_PUBLIC_BRAND_METADATA_KEY]: publicBrand,
  };
}

function publicBrandFromMetadata(
  metadata: Readonly<Record<string, string>>,
): PublicBrand {
  return metadata[ARTIFACT_PUBLIC_BRAND_METADATA_KEY] === "okou"
    ? "okou"
    : "vm0";
}

function filenameFromMetadata(
  metadata: Readonly<Record<string, string>>,
): string | undefined {
  const encoded = metadata[ARTIFACT_FILENAME_METADATA_KEY];
  if (encoded === undefined) {
    return undefined;
  }
  return safeUriComponentDecode(encoded) ?? undefined;
}

function filenameFromLegacyKey(key: string): string {
  return decodeURIComponent(key.split("/").pop() ?? key);
}

function collisionVariant(variant: string, attempt: number): string {
  return attempt === 0 ? variant : `${variant}\0${String(attempt)}`;
}

export const allocateArtifactObject$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly filename: string;
      readonly publicBrand: PublicBrand;
      readonly id?: string;
      readonly variant?: string;
    },
    signal: AbortSignal,
  ): Promise<ArtifactObjectLocation> => {
    signal.throwIfAborted();

    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    for (let attempt = 0; attempt < MAX_ARTIFACT_KEY_ATTEMPTS; attempt += 1) {
      const id =
        args.id !== undefined && (args.variant !== undefined || attempt === 0)
          ? args.id
          : randomUUID();
      const variant =
        args.variant === undefined
          ? undefined
          : collisionVariant(args.variant, attempt);
      const prefix = buildArtifactPrefixV2(id, variant);
      const key = buildArtifactKeyV2(id, args.filename, variant);
      const existing = await get(listS3Objects(bucket, prefix));
      signal.throwIfAborted();
      if (existing.length === 0) {
        return {
          id,
          key,
          url: buildFileUrlFromKey(key, args.publicBrand),
          metadata: artifactObjectMetadata(
            args.userId,
            id,
            args.filename,
            args.publicBrand,
          ),
        };
      }

      if (args.id !== undefined && args.variant !== undefined) {
        const sameKey = existing.find((object) => {
          return object.key === key;
        });
        if (sameKey) {
          const head = await get(s3ObjectHead(bucket, key));
          signal.throwIfAborted();
          if (
            head.kind === "found" &&
            head.metadata[ARTIFACT_ID_METADATA_KEY] === id &&
            head.metadata[ARTIFACT_USER_ID_METADATA_KEY] ===
              encodeURIComponent(args.userId) &&
            filenameFromMetadata(head.metadata) === args.filename
          ) {
            const publicBrand = publicBrandFromMetadata(head.metadata);
            return {
              id,
              key,
              url: buildFileUrlFromKey(key, publicBrand),
              metadata: artifactObjectMetadata(
                args.userId,
                id,
                args.filename,
                publicBrand,
              ),
            };
          }
        }
      }
    }

    throw new Error("Unable to allocate a unique artifact key");
  },
);

export const storeGeneratedArtifactObject$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly filenamePrefix: string;
      readonly extension: string;
      readonly body: Buffer;
      readonly contentType: string;
      readonly publicBrand: PublicBrand;
    },
    signal: AbortSignal,
  ): Promise<StoredGeneratedArtifactObject> => {
    const proposedId = randomUUID();
    const extension = args.extension.replace(/^\./u, "");
    const filenameFor = (id: string) => {
      return `${args.filenamePrefix}-${id.slice(0, 8)}.${extension}`;
    };
    const artifact = await set(
      allocateArtifactObject$,
      {
        userId: args.userId,
        id: proposedId,
        filename: filenameFor(proposedId),
        publicBrand: args.publicBrand,
      },
      signal,
    );
    const filename = filenameFor(artifact.id);
    const metadata = artifactObjectMetadata(
      args.userId,
      artifact.id,
      filename,
      args.publicBrand,
    );
    await get(
      putS3Object(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        artifact.key,
        args.body,
        args.contentType,
        { signal, metadata },
      ),
    );
    signal.throwIfAborted();
    return { ...artifact, filename, metadata };
  },
);

function resolveV2ArtifactObject(
  bucket: string,
  userId: string,
  id: string,
): Computed<Promise<ResolvedArtifactObject | null>> {
  return computed(async (get): Promise<ResolvedArtifactObject | null> => {
    const objects = await get(listS3Objects(bucket, buildArtifactPrefixV2(id)));
    for (const object of objects) {
      const head = await get(s3ObjectHead(bucket, object.key));
      if (
        head.kind === "missing" ||
        head.metadata[ARTIFACT_ID_METADATA_KEY] !== id ||
        head.metadata[ARTIFACT_USER_ID_METADATA_KEY] !==
          encodeURIComponent(userId)
      ) {
        continue;
      }
      const filename =
        filenameFromMetadata(head.metadata) ??
        filenameFromLegacyKey(object.key);
      return {
        key: object.key,
        url: buildFileUrlFromKey(
          object.key,
          publicBrandFromMetadata(head.metadata),
        ),
        filename,
        contentType: head.contentType ?? inferMimetype(filename),
        size: head.contentLength ?? object.size,
        lastModified: head.lastModified ?? object.lastModified,
      };
    }
    return null;
  });
}

function resolveV1ArtifactObject(
  bucket: string,
  userId: string,
  id: string,
): Computed<Promise<ResolvedArtifactObject | null>> {
  return computed(async (get): Promise<ResolvedArtifactObject | null> => {
    const objects = await get(
      listS3Objects(bucket, buildArtifactPrefix(userId, id)),
    );
    const object = objects[0];
    if (!object) {
      return null;
    }
    const filename = filenameFromLegacyKey(object.key);
    return {
      key: object.key,
      url: buildFileUrlFromKey(object.key, "vm0"),
      filename,
      contentType: inferMimetype(filename),
      size: object.size,
      lastModified: object.lastModified,
    };
  });
}

export function resolvedArtifactObject(
  userId: string,
  id: string,
): Computed<Promise<ResolvedArtifactObject | null>> {
  return computed(async (get): Promise<ResolvedArtifactObject | null> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    return (
      (await get(resolveV2ArtifactObject(bucket, userId, id))) ??
      (await get(resolveV1ArtifactObject(bucket, userId, id)))
    );
  });
}

export const resolveArtifactObject$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<ResolvedArtifactObject | null> => {
    const resolved = await get(resolvedArtifactObject(args.userId, args.id));
    signal.throwIfAborted();
    return resolved;
  },
);

export const resolveArtifactMultipartUpload$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly id: string;
      readonly filename: string;
      readonly uploadId: string;
    },
    signal: AbortSignal,
  ): Promise<ResolvedArtifactMultipartUpload | null> => {
    const sanitizedFilename = sanitizeArtifactFilename(args.filename);
    const v1Key = buildArtifactKey(args.userId, args.id, sanitizedFilename);
    const v2Key = buildArtifactKeyV2(args.id, args.filename);
    // Accept multipart uploads started by previous clients while they drain.
    const keys = [v2Key, v1Key];
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    for (const key of keys) {
      const parts = await get(
        tryListMultipartS3Parts(bucket, key, args.uploadId),
      );
      signal.throwIfAborted();
      if (parts !== null) {
        return { key, parts };
      }
    }
    return null;
  },
);
