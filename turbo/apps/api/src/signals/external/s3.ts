import { computed, type Computed } from "ccstate";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

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

const s3Client$ = computed((): S3Client => {
  return new S3Client({
    region: "auto",
    endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    },
  });
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
