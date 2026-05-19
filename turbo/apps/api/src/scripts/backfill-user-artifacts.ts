import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { env, optionalEnv } from "../lib/env";
import { settle } from "../signals/utils";

const CLERK_USER_ID_PREFIX = "user_";
const DEFAULT_CONCURRENCY = 8;

interface Options {
  readonly concurrency: number;
  readonly execute: boolean;
  readonly limit: number | undefined;
}

interface Counts {
  copied: number;
  existing: number;
  failed: number;
  scanned: number;
  skipped: number;
}

function parseOptions(argv: readonly string[]): Options {
  let concurrency = DEFAULT_CONCURRENCY;
  let execute = false;
  let limit: number | undefined;

  for (const arg of argv) {
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      concurrency = Number.parseInt(arg.slice("--concurrency=".length), 10);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = Number.parseInt(arg.slice("--limit=".length), 10);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  return { concurrency, execute, limit };
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeErrorLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function createClient(): S3Client {
  const endpoint =
    env("S3_ENDPOINT") ??
    `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;

  return new S3Client({
    region: env("S3_REGION") ?? "auto",
    endpoint,
    credentials: {
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: optionalEnv("S3_FORCE_PATH_STYLE") === "true",
  });
}

function publicFileUserIdSegment(userId: string): string {
  return userId.startsWith(CLERK_USER_ID_PREFIX)
    ? userId.slice(CLERK_USER_ID_PREFIX.length)
    : userId;
}

function artifactKeyFromUploadsKey(sourceKey: string): string | null {
  const parts = sourceKey.split("/");
  if (parts.length < 4 || parts[0] !== "uploads") {
    return null;
  }

  const storageUserId = parts[1]!;
  const fileId = parts[2]!;
  const filename = parts.slice(3).join("/");
  if (!storageUserId || !fileId || !filename) {
    return null;
  }

  return [
    "artifacts",
    encodeURIComponent(publicFileUserIdSegment(storageUserId)),
    fileId,
    encodeURIComponent(filename),
  ].join("/");
}

function copySource(bucket: string, key: string): string {
  return `${encodeURIComponent(bucket)}/${key
    .split("/")
    .map((segment) => {
      return encodeURIComponent(segment);
    })
    .join("/")}`;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function objectExists(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  const result = await settle(
    client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
  );
  if (result.ok) {
    return true;
  }
  if (isNotFound(result.error)) {
    return false;
  }
  throw result.error;
}

async function* listUploadKeys(
  client: S3Client,
  bucket: string,
  limit: number | undefined,
): AsyncGenerator<string> {
  let continuationToken: string | undefined;
  let yielded = 0;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "uploads/",
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of response.Contents ?? []) {
      if (!item.Key) {
        continue;
      }
      yield item.Key;
      yielded += 1;
      if (limit !== undefined && yielded >= limit) {
        return;
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
}

async function processKey(args: {
  readonly client: S3Client;
  readonly counts: Counts;
  readonly execute: boolean;
  readonly newBucket: string;
  readonly oldBucket: string;
  readonly sourceKey: string;
}): Promise<void> {
  args.counts.scanned += 1;

  const targetKey = artifactKeyFromUploadsKey(args.sourceKey);
  if (!targetKey) {
    args.counts.skipped += 1;
    return;
  }

  if (await objectExists(args.client, args.newBucket, targetKey)) {
    args.counts.existing += 1;
    return;
  }

  if (!args.execute) {
    args.counts.copied += 1;
    writeLine(`[dry-run] ${args.sourceKey} -> ${targetKey}`);
    return;
  }

  await args.client.send(
    new CopyObjectCommand({
      Bucket: args.newBucket,
      Key: targetKey,
      CopySource: copySource(args.oldBucket, args.sourceKey),
    }),
  );
  args.counts.copied += 1;
  writeLine(`${args.sourceKey} -> ${targetKey}`);
}

async function flushBatch(batch: readonly Promise<void>[]): Promise<void> {
  await Promise.all(batch);
}

async function processKeySafely(args: {
  readonly client: S3Client;
  readonly counts: Counts;
  readonly execute: boolean;
  readonly newBucket: string;
  readonly oldBucket: string;
  readonly sourceKey: string;
}): Promise<void> {
  const result = await settle(processKey(args));
  if (!result.ok) {
    args.counts.failed += 1;
    writeErrorLine(`failed ${args.sourceKey}: ${errorMessage(result.error)}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const oldBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const newBucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const client = createClient();
  const counts: Counts = {
    copied: 0,
    existing: 0,
    failed: 0,
    scanned: 0,
    skipped: 0,
  };

  let batch: Promise<void>[] = [];
  for await (const sourceKey of listUploadKeys(
    client,
    oldBucket,
    options.limit,
  )) {
    batch.push(
      processKeySafely({
        client,
        counts,
        execute: options.execute,
        newBucket,
        oldBucket,
        sourceKey,
      }),
    );

    if (batch.length >= options.concurrency) {
      await flushBatch(batch);
      batch = [];
    }
  }
  await flushBatch(batch);

  writeLine(
    JSON.stringify(
      {
        mode: options.execute ? "execute" : "dry-run",
        oldBucket,
        newBucket,
        ...counts,
      },
      null,
      2,
    ),
  );

  if (counts.failed > 0) {
    process.exitCode = 1;
  }
}

const result = await settle(main());
if (!result.ok) {
  writeErrorLine(errorMessage(result.error));
  process.exitCode = 1;
}
