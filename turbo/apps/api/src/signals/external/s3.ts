import { computed, type Computed } from "ccstate";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "../../lib/env";

interface S3Object {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

interface S3FileEntry {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

interface S3StorageManifest {
  readonly version: string;
  readonly createdAt: string;
  readonly totalSize: number;
  readonly fileCount: number;
  readonly files: readonly S3FileEntry[];
}

function createS3Client(endpoint: string): S3Client {
  return new S3Client({
    region: env("S3_REGION") ?? "auto",
    endpoint,
    credentials: {
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: env("S3_FORCE_PATH_STYLE") === "true",
  });
}

function defaultS3Endpoint(): string {
  return `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
}

const s3Client$ = computed((): S3Client => {
  return createS3Client(env("S3_ENDPOINT") ?? defaultS3Endpoint());
});

const publicS3Client$ = computed((get): S3Client => {
  const publicEndpoint = env("S3_PUBLIC_ENDPOINT");
  if (!publicEndpoint) {
    return get(s3Client$);
  }
  return createS3Client(publicEndpoint);
});

export function listS3Objects(
  bucket: string,
  prefix: string,
): Computed<Promise<readonly S3Object[]>> {
  return computed(async (get): Promise<readonly S3Object[]> => {
    const client = get(s3Client$);
    const objects: S3Object[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const item of response.Contents ?? []) {
        if (item.Key && item.Size !== undefined && item.LastModified) {
          objects.push({
            key: item.Key,
            size: item.Size,
            lastModified: item.LastModified,
          });
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objects;
  });
}

export function deleteS3Objects(
  bucket: string,
  keys: readonly string[],
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    if (keys.length === 0) {
      return;
    }
    const client = get(s3Client$);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: keys.map((Key) => {
            return { Key };
          }),
        },
      }),
    );
  });
}

export function downloadS3Buffer(
  bucket: string,
  key: string,
): Computed<Promise<Buffer>> {
  return computed(async (get): Promise<Buffer> => {
    const client = get(s3Client$);
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error("S3 object body is empty");
    }
    const chunks: Uint8Array[] = [];
    const stream = response.Body as unknown as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const totalLength = chunks.reduce((acc, c) => {
      return acc + c.length;
    }, 0);
    return Buffer.concat(
      chunks.map((c) => {
        return Buffer.from(c);
      }),
      totalLength,
    );
  });
}

/**
 * Generate a presigned PUT URL so the browser/CLI can upload a file body
 * directly to R2. The body never passes through the api runtime, which
 * bypasses the Vercel ~4.5 MB body cap. Callers materialize the URL once
 * per upload; the signature is short-lived and not persistable.
 */
export function generatePresignedPutUrl(
  bucket: string,
  key: string,
  contentType: string,
  expiresIn: number,
  usePublicEndpoint = false,
): Computed<Promise<string>> {
  return computed((get): Promise<string> => {
    const client = get(usePublicEndpoint ? publicS3Client$ : s3Client$);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(client, command, { expiresIn });
  });
}

export function downloadManifest(
  bucket: string,
  s3Key: string,
): Computed<Promise<S3StorageManifest>> {
  return computed(async (get): Promise<S3StorageManifest> => {
    const manifestBuffer = await get(
      downloadS3Buffer(bucket, `${s3Key}/manifest.json`),
    );
    return JSON.parse(manifestBuffer.toString("utf8")) as S3StorageManifest;
  });
}
