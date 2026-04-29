import { computed, type Computed } from "ccstate";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { env } from "../../lib/env";

interface S3Object {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

const s3Client$ = computed((): S3Client | null => {
  const accessKeyId = env("R2_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }
  const endpoint =
    env("S3_ENDPOINT") ??
    `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: env("S3_REGION") ?? "auto",
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    forcePathStyle: env("S3_FORCE_PATH_STYLE") === "true",
  });
});

export function listS3Objects(
  bucket: string,
  prefix: string,
): Computed<Promise<readonly S3Object[]>> {
  return computed(async (get): Promise<readonly S3Object[]> => {
    const client = get(s3Client$);
    if (!client) {
      return [];
    }
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
