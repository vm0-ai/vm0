import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { forEachConcurrent } from "./concurrent";

interface Options {
  readonly publicBucket: string;
  readonly hostedBucket: string;
  readonly maxObjects: number;
  readonly concurrency?: number;
  readonly onProgress?: (phase: string, completed: number) => void;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pending multipart upload registration is invalid");
  return value as Record<string, unknown>;
}

function validateRegistration(value: unknown, key: string) {
  const record = objectRecord(value);
  if (
    record.version !== 1 ||
    record.kind !== "legacy-file" ||
    record.audience !== "public" ||
    record.key !== key ||
    (record.publicBrand !== "vm0" && record.publicBrand !== "okou") ||
    typeof record.filename !== "string" ||
    !record.filename ||
    typeof record.contentType !== "string" ||
    !record.contentType
  )
    throw new Error("Pending multipart upload registration is invalid");
}

async function registration(client: S3Client, bucket: string, key: string) {
  let result: GetObjectCommandOutput;
  try {
    result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      ["NoSuchKey", "NotFound"].includes(error.name)
    )
      return undefined;
    throw error;
  }
  if (!result.Body)
    throw new Error("Pending multipart registration has no body");
  const body = await result.Body.transformToString();
  try {
    const value: unknown = JSON.parse(body);
    return value;
  } catch {
    throw new Error("Pending multipart registration contains invalid JSON");
  }
}

/** Frozen v1 public registration check, shared by preflight and final coverage. */
export async function pendingMultipartRegistrations(
  publicClient: S3Client,
  hostedClient: S3Client,
  options: Options,
) {
  const concurrency = options.concurrency ?? 16;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new Error("Concurrency must be between 1 and 64");
  if (!Number.isSafeInteger(options.maxObjects) || options.maxObjects < 1)
    throw new Error("--max-objects must be a positive integer");
  const startedAt = new Date().toISOString();
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  let pending = 0;
  let unregistered = 0;
  let unknownInitiated = 0;
  let oldestInitiated: string | null = null;
  let newestInitiated: string | null = null;
  do {
    const page = await publicClient.send(
      new ListMultipartUploadsCommand({
        Bucket: options.publicBucket,
        Prefix: "artifacts/",
        MaxUploads: 1000,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );
    await forEachConcurrent(page.Uploads ?? [], concurrency, async (upload) => {
      const key = upload.Key;
      if (!key?.startsWith("artifacts/") || !upload.UploadId)
        throw new Error("Invalid pending multipart upload identity");
      if (++pending > options.maxObjects)
        throw new Error("Pending multipart upload inventory limit reached");
      const alias = encodeURIComponent(key.slice("artifacts/".length));
      const value = await registration(
        hostedClient,
        options.hostedBucket,
        `artifact-delivery/files/${alias}.json`,
      );
      if (value === undefined) {
        unregistered++;
        if (upload.Initiated === undefined) {
          unknownInitiated++;
        } else {
          if (!Number.isFinite(upload.Initiated.getTime()))
            throw new Error("Invalid pending multipart initiation time");
          const initiated = upload.Initiated.toISOString();
          if (oldestInitiated === null || initiated < oldestInitiated)
            oldestInitiated = initiated;
          if (newestInitiated === null || initiated > newestInitiated)
            newestInitiated = initiated;
        }
        return;
      }
      validateRegistration(value, key);
    });
    if (
      page.IsTruncated &&
      (!page.NextKeyMarker ||
        !page.NextUploadIdMarker ||
        (page.NextKeyMarker === keyMarker &&
          page.NextUploadIdMarker === uploadIdMarker))
    )
      throw new Error("Pending multipart upload pagination is incomplete");
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker);
  options.onProgress?.("pending-multipart-uploads", pending);
  options.onProgress?.("unregistered-multipart-uploads", unregistered);
  return {
    pending,
    unregistered,
    startedAt,
    completedAt: new Date().toISOString(),
    oldestUnregisteredInitiatedAt: oldestInitiated,
    newestUnregisteredInitiatedAt: newestInitiated,
    unregisteredWithUnknownInitiationTime: unknownInitiated,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Read-only CLI: no database, object inventory, registration writes or finalize. */
export async function runMultipartPreflight(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "max-objects": { type: "string", default: "100000" },
      concurrency: { type: "string", default: "16" },
      report: { type: "string" },
    },
  });
  const endpoint = `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const publicClient = new S3Client({
    endpoint,
    region: "auto",
    credentials: {
      accessKeyId: required("R2_USER_ARTIFACTS_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_USER_ARTIFACTS_SECRET_ACCESS_KEY"),
    },
  });
  const hostedClient = new S3Client({
    endpoint,
    region: "auto",
    credentials: {
      accessKeyId: required("R2_HOSTED_SITES_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_HOSTED_SITES_SECRET_ACCESS_KEY"),
    },
  });
  try {
    const result = await pendingMultipartRegistrations(
      publicClient,
      hostedClient,
      {
        publicBucket: required("R2_USER_ARTIFACTS_BUCKET_NAME"),
        hostedBucket: required("R2_HOSTED_SITES_BUCKET_NAME"),
        maxObjects: Number(values["max-objects"]),
        concurrency: Number(values.concurrency),
      },
    );
    const report = {
      kind: "multipart-preflight",
      status: result.unregistered > 0 ? "blocked" : "clear",
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      pendingMultipartUploads: result.pending,
      unregisteredMultipartUploads: result.unregistered,
      oldestUnregisteredInitiatedAt: result.oldestUnregisteredInitiatedAt,
      newestUnregisteredInitiatedAt: result.newestUnregisteredInitiatedAt,
      unregisteredWithUnknownInitiationTime:
        result.unregisteredWithUnknownInitiationTime,
      verified: false,
      finalized: false,
    };
    if (values.report)
      await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
    return result.unregistered > 0 ? 1 : 0;
  } finally {
    publicClient.destroy();
    hostedClient.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runMultipartPreflight(process.argv.slice(2));
