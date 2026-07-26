import { computed, type Computed } from "ccstate";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
  type SessionHistoryDownloadSource,
} from "@vm0/api-contracts/contracts/runners";

import { env } from "../../lib/env";
import { detach, Mechanism, settle } from "../utils";

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

interface DownloadS3BufferOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export type ConditionalS3BufferDownload =
  | { readonly kind: "not-modified" }
  | {
      readonly kind: "downloaded";
      readonly buffer: Buffer;
      readonly etag: string | null;
    };

export class S3ObjectSizeLimitError extends Error {
  constructor(
    readonly key: string,
    readonly size: number,
    readonly maxBytes: number,
    readonly etag: string | null = null,
  ) {
    super(`S3 object is too large: ${size} bytes exceeds ${maxBytes} bytes`);
    this.name = "S3ObjectSizeLimitError";
  }
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

export function publicS3DownloadSource(): SessionHistoryDownloadSource {
  // Mirror `generatePresignedGetUrl(..., usePublicEndpoint=true)` without exposing the endpoint.
  return env("S3_PUBLIC_ENDPOINT") || env("S3_ENDPOINT")
    ? SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT
    : SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT;
}

function userArtifactsS3Credentials(): S3Credentials {
  return {
    accessKeyId: env("R2_USER_ARTIFACTS_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_USER_ARTIFACTS_SECRET_ACCESS_KEY"),
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

const userArtifactsS3Client$ = computed((): S3Client => {
  return createS3Client(
    env("S3_ENDPOINT") ?? defaultS3Endpoint(),
    userArtifactsS3Credentials(),
  );
});

const userArtifactsPublicS3Client$ = computed((get): S3Client => {
  const publicEndpoint = env("S3_PUBLIC_ENDPOINT");
  if (!publicEndpoint) {
    return get(userArtifactsS3Client$);
  }
  return createS3Client(publicEndpoint, userArtifactsS3Credentials());
});

function s3ClientForBucket(
  bucket: string,
  usePublicEndpoint = false,
): Computed<S3Client> {
  if (bucket === env("R2_USER_ARTIFACTS_BUCKET_NAME")) {
    return usePublicEndpoint
      ? userArtifactsPublicS3Client$
      : userArtifactsS3Client$;
  }
  return usePublicEndpoint ? publicS3Client$ : s3Client$;
}

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
    const client = get(s3ClientForBucket(bucket));
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

export function listS3ObjectsUnderPrefix(
  bucket: string,
  prefix: string,
): Computed<Promise<readonly S3Object[]>> {
  const boundedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return listS3Objects(bucket, boundedPrefix);
}

export function deleteS3Objects(
  bucket: string,
  keys: readonly string[],
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    if (keys.length === 0) {
      return;
    }
    const client = get(s3ClientForBucket(bucket));
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
  return downloadS3BufferWithClient(s3ClientForBucket(bucket), bucket, key);
}

export function downloadS3BufferWithMaxBytes(
  bucket: string,
  key: string,
  maxBytes: number,
  signal?: AbortSignal,
): Computed<Promise<Buffer>> {
  return downloadS3BufferWithClient(s3ClientForBucket(bucket), bucket, key, {
    maxBytes,
    signal,
  });
}

export function downloadS3BufferWithMaxBytesIfChanged(
  bucket: string,
  key: string,
  maxBytes: number,
  ifNoneMatch: string | null,
  signal?: AbortSignal,
): Computed<Promise<ConditionalS3BufferDownload>> {
  return computed(async (get): Promise<ConditionalS3BufferDownload> => {
    const client = get(s3ClientForBucket(bucket));
    const downloaded = await settle(
      client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          IfNoneMatch: ifNoneMatch ?? undefined,
        }),
        { abortSignal: signal },
      ),
    );
    if (!downloaded.ok) {
      if (isS3NotModifiedError(downloaded.error)) {
        return { kind: "not-modified" };
      }
      throw downloaded.error;
    }
    const response: GetObjectCommandOutput = downloaded.value;
    return {
      kind: "downloaded",
      buffer: await readS3ObjectBody(response, key, { maxBytes, signal }),
      etag: response.ETag ?? null,
    };
  });
}

function isAsyncIterableByteStream(
  value: unknown,
): value is AsyncIterable<Uint8Array> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const iterator = (value as { [Symbol.asyncIterator]?: unknown })[
    Symbol.asyncIterator
  ];
  return typeof iterator === "function";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const then = (value as { then?: unknown }).then;
  return typeof then === "function";
}

function isS3NotModifiedError(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("$metadata" in value)) {
    return false;
  }
  const metadata = value.$metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    metadata.httpStatusCode === 304
  );
}

function closeS3Body(body: unknown): void {
  if (!body || typeof body !== "object") {
    return;
  }

  const destroy = (body as { destroy?: () => void }).destroy;
  if (typeof destroy === "function") {
    destroy.call(body);
    return;
  }

  const cancel = (body as { cancel?: () => unknown }).cancel;
  if (typeof cancel === "function") {
    const result = cancel.call(body);
    if (isPromiseLike(result)) {
      detach(
        Promise.resolve(result),
        Mechanism.BestEffortCleanup,
        "s3 body cancel",
      );
    }
  }
}

function downloadS3BufferWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
  options: DownloadS3BufferOptions = {},
): Computed<Promise<Buffer>> {
  return computed(async (get): Promise<Buffer> => {
    const client = get(client$);
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: options.signal },
    );
    return await readS3ObjectBody(response, key, options);
  });
}

async function readS3ObjectBody(
  response: {
    readonly Body?: unknown;
    readonly ContentLength?: number;
    readonly ETag?: string;
  },
  key: string,
  options: DownloadS3BufferOptions,
): Promise<Buffer> {
  if (!response.Body) {
    throw new Error("S3 object body is empty");
  }
  if (!isAsyncIterableByteStream(response.Body)) {
    closeS3Body(response.Body);
    throw new Error("S3 object body is not an async byte stream");
  }
  if (options.signal?.aborted) {
    closeS3Body(response.Body);
    options.signal.throwIfAborted();
  }
  if (
    options.maxBytes !== undefined &&
    response.ContentLength !== undefined &&
    response.ContentLength > options.maxBytes
  ) {
    closeS3Body(response.Body);
    throw new S3ObjectSizeLimitError(
      key,
      response.ContentLength,
      options.maxBytes,
      response.ETag ?? null,
    );
  }
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of response.Body) {
    if (options.signal?.aborted) {
      closeS3Body(response.Body);
      options.signal.throwIfAborted();
    }
    if (!(chunk instanceof Uint8Array)) {
      closeS3Body(response.Body);
      throw new Error("S3 object body yielded a non-byte chunk");
    }
    totalLength += chunk.length;
    if (options.maxBytes !== undefined && totalLength > options.maxBytes) {
      closeS3Body(response.Body);
      throw new S3ObjectSizeLimitError(
        key,
        totalLength,
        options.maxBytes,
        response.ETag ?? null,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(
    chunks.map((chunk) => {
      return Buffer.from(chunk);
    }),
    totalLength,
  );
}

export function downloadHostedSitesS3Buffer(
  bucket: string,
  key: string,
): Computed<Promise<Buffer>> {
  return downloadS3BufferWithClient(hostedSitesS3Client$, bucket, key);
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
    s3ClientForBucket(bucket, usePublicEndpoint),
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

export function generateHostedSitesPresignedGetUrl(
  bucket: string,
  key: string,
  expiresIn: number,
  usePublicEndpoint = false,
): Computed<Promise<string>> {
  return generatePresignedGetUrlWithClient(
    usePublicEndpoint ? hostedSitesPublicS3Client$ : hostedSitesS3Client$,
    bucket,
    key,
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
  return generatePresignedGetUrlWithClient(
    s3ClientForBucket(bucket, usePublicEndpoint),
    bucket,
    key,
    expiresIn,
    filename,
  );
}

function generatePresignedGetUrlWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
  expiresIn: number,
  filename?: string,
): Computed<Promise<string>> {
  return computed((get): Promise<string> => {
    const client = get(client$);
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
  signal?: AbortSignal,
): Computed<Promise<void>> {
  return putS3ObjectWithClient(s3ClientForBucket(bucket), {
    bucket,
    key,
    body,
    contentType,
    signal,
  });
}

interface PutS3ObjectArgs {
  readonly bucket: string;
  readonly key: string;
  readonly body: string | Buffer;
  readonly contentType: string;
  readonly signal?: AbortSignal;
}

function putS3ObjectWithClient(
  client$: Computed<S3Client>,
  args: PutS3ObjectArgs,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const client = get(client$);
    await client.send(
      new PutObjectCommand({
        Bucket: args.bucket,
        Key: args.key,
        Body: args.body,
        ContentType: args.contentType,
      }),
      args.signal ? { abortSignal: args.signal } : undefined,
    );
  });
}

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

function isS3PreconditionFailedError(error: unknown): boolean {
  const candidate = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return (
    candidate.name === "PreconditionFailed" ||
    candidate.$metadata?.httpStatusCode === 412
  );
}

/**
 * Upload an object exactly once. An existing key is an idempotent success, so
 * callers can safely retry without changing bytes behind an immutable URL.
 */
export function putImmutableS3Object(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
  signal?: AbortSignal,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const client = get(s3ClientForBucket(bucket));
    const uploaded = await settle(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: IMMUTABLE_CACHE_CONTROL,
          IfNoneMatch: "*",
        }),
        signal ? { abortSignal: signal } : undefined,
      ),
    );
    if (!uploaded.ok && !isS3PreconditionFailedError(uploaded.error)) {
      throw uploaded.error;
    }
  });
}

export function putHostedSitesS3Object(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
): Computed<Promise<void>> {
  return putS3ObjectWithClient(hostedSitesS3Client$, {
    bucket,
    key,
    body,
    contentType,
  });
}

function s3CopySource(bucket: string, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${bucket}/${encodedKey}`;
}

export function copyHostedSitesS3Object(
  bucket: string,
  sourceKey: string,
  destinationKey: string,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const client = get(hostedSitesS3Client$);
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: s3CopySource(bucket, sourceKey),
        Key: destinationKey,
      }),
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

export function s3ObjectContentLength(
  bucket: string,
  key: string,
  maxBytes?: number,
): Computed<Promise<number | undefined>> {
  return s3ObjectContentLengthWithClient(
    s3ClientForBucket(bucket),
    bucket,
    key,
    maxBytes,
  );
}

export type S3ObjectHead =
  | { readonly kind: "missing" }
  | {
      readonly kind: "found";
      readonly contentLength: number | undefined;
    };

function isS3NotFoundError(error: unknown): boolean {
  const candidate = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return (
    candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404
  );
}

export function s3ObjectHead(
  bucket: string,
  key: string,
): Computed<Promise<S3ObjectHead>> {
  return s3ObjectHeadWithClient(s3ClientForBucket(bucket), bucket, key);
}

function s3ObjectHeadWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
): Computed<Promise<S3ObjectHead>> {
  return computed(async (get): Promise<S3ObjectHead> => {
    const client = get(client$);
    const result = await settle(
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    );
    if (!result.ok) {
      if (isS3NotFoundError(result.error)) {
        return { kind: "missing" };
      }
      throw result.error;
    }

    return {
      kind: "found",
      contentLength: result.value.ContentLength,
    };
  });
}

function s3ObjectContentLengthWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
  maxBytes: number | undefined,
): Computed<Promise<number | undefined>> {
  return computed(async (get): Promise<number | undefined> => {
    const result = await get(s3ObjectHeadWithClient(client$, bucket, key));
    if (result.kind === "missing") {
      return undefined;
    }

    const contentLength = result.contentLength;
    if (contentLength === undefined) {
      return undefined;
    }
    if (maxBytes !== undefined && contentLength > maxBytes) {
      throw new S3ObjectSizeLimitError(key, contentLength, maxBytes);
    }
    return contentLength;
  });
}

export function s3ObjectExists(
  bucket: string,
  key: string,
): Computed<Promise<boolean>> {
  return s3ObjectExistsWithClient(s3ClientForBucket(bucket), bucket, key);
}

function s3ObjectExistsWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const client = get(client$);
    const result = await settle(
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    );
    if (result.ok) {
      return true;
    }
    if (isS3NotFoundError(result.error)) {
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
  options?: {
    readonly allowMissingObjectsForEmptyVersion?: boolean;
  },
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    if (
      fileCount === 0 &&
      options?.allowMissingObjectsForEmptyVersion === true
    ) {
      return true;
    }

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
