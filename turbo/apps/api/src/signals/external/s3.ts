import { computed, type Computed } from "ccstate";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env } from "../../lib/env";
import { safeAsync } from "../utils";

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

interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function createS3Client(
  endpoint: string,
  credentials: S3Credentials,
): S3Client {
  return new S3Client({
    region: env("S3_REGION") ?? "auto",
    endpoint,
    credentials,
    forcePathStyle: env("S3_FORCE_PATH_STYLE") === "true",
  });
}

function defaultS3Endpoint(): string {
  return `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
}

function defaultS3Credentials(): S3Credentials {
  return {
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  };
}

function hostedSitesS3Credentials(): S3Credentials {
  const accessKeyId = env("R2_HOSTED_SITES_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_HOSTED_SITES_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_HOSTED_SITES_ACCESS_KEY_ID and R2_HOSTED_SITES_SECRET_ACCESS_KEY must be configured",
    );
  }
  return { accessKeyId, secretAccessKey };
}

const s3Client$ = computed((): S3Client => {
  return createS3Client(
    env("S3_ENDPOINT") ?? defaultS3Endpoint(),
    defaultS3Credentials(),
  );
});

const publicS3Client$ = computed((get): S3Client => {
  const publicEndpoint = env("S3_PUBLIC_ENDPOINT");
  if (!publicEndpoint) {
    return get(s3Client$);
  }
  return createS3Client(publicEndpoint, defaultS3Credentials());
});

const hostedSitesS3Client$ = computed((): S3Client => {
  return createS3Client(
    env("S3_ENDPOINT") ?? defaultS3Endpoint(),
    hostedSitesS3Credentials(),
  );
});

const hostedSitesPublicS3Client$ = computed((get): S3Client => {
  const publicEndpoint = env("S3_PUBLIC_ENDPOINT");
  if (!publicEndpoint) {
    return get(hostedSitesS3Client$);
  }
  return createS3Client(publicEndpoint, hostedSitesS3Credentials());
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
  return generatePresignedPutUrlWithClient(
    usePublicEndpoint ? publicS3Client$ : s3Client$,
    bucket,
    key,
    contentType,
    expiresIn,
  );
}

function generatePresignedPutUrlWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
  contentType: string,
  expiresIn: number,
): Computed<Promise<string>> {
  return computed((get): Promise<string> => {
    const client = get(client$);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(client, command, { expiresIn });
  });
}

export function generateHostedSitesPresignedPutUrl(
  bucket: string,
  key: string,
  contentType: string,
  expiresIn: number,
  usePublicEndpoint = false,
): Computed<Promise<string>> {
  return generatePresignedPutUrlWithClient(
    usePublicEndpoint ? hostedSitesPublicS3Client$ : hostedSitesS3Client$,
    bucket,
    key,
    contentType,
    expiresIn,
  );
}

export function generatePresignedGetUrl(
  bucket: string,
  key: string,
  expiresIn: number,
  filename?: string,
  usePublicEndpoint = false,
): Computed<Promise<string>> {
  return computed((get): Promise<string> => {
    const client = get(usePublicEndpoint ? publicS3Client$ : s3Client$);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(filename
        ? { ResponseContentDisposition: `attachment; filename="${filename}"` }
        : {}),
    });
    return getSignedUrl(client, command, { expiresIn });
  });
}

export function putS3Object(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
): Computed<Promise<void>> {
  return putS3ObjectWithClient(s3Client$, bucket, key, body, contentType);
}

function putS3ObjectWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const client = get(client$);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  });
}

export function putHostedSitesS3Object(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
): Computed<Promise<void>> {
  return putS3ObjectWithClient(
    hostedSitesS3Client$,
    bucket,
    key,
    body,
    contentType,
  );
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

export function s3ObjectExists(
  bucket: string,
  key: string,
): Computed<Promise<boolean>> {
  return s3ObjectExistsWithClient(s3Client$, bucket, key);
}

function s3ObjectExistsWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const client = get(client$);
    const result = await safeAsync(async () => {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    });
    if ("ok" in result) {
      return true;
    }

    const candidate = result.error as {
      readonly name?: string;
      readonly $metadata?: { readonly httpStatusCode?: number };
    };
    if (
      candidate.name === "NotFound" ||
      candidate.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    throw result.error;
  });
}

export function hostedSitesS3ObjectExists(
  bucket: string,
  key: string,
): Computed<Promise<boolean>> {
  return s3ObjectExistsWithClient(hostedSitesS3Client$, bucket, key);
}

export function verifyS3FilesExist(
  bucket: string,
  s3Key: string,
  fileCount: number,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const manifestKey = `${s3Key}/manifest.json`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const [manifestExists, archiveExists] = await Promise.all([
      get(s3ObjectExists(bucket, manifestKey)),
      fileCount > 0
        ? get(s3ObjectExists(bucket, archiveKey))
        : Promise.resolve(true),
    ]);

    return manifestExists && archiveExists;
  });
}
