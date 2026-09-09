import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";
import { forEachConcurrent } from "./concurrent";
import { resolveLegacyClickTrackContentType } from "./legacy-click-track";
// Frozen v1 format: numbered data migrations must remain runnable after app
// contracts evolve. Only confirmed historical Public records are constructed.
type PublicBrand = "vm0" | "okou";
type HistoricalPublicRecord = {
  readonly version: 1;
  readonly publicBrand: PublicBrand;
  readonly audience: "public";
} & (
  | {
      readonly kind: "legacy-file";
      readonly key: string;
      readonly filename: string;
      readonly contentType: string;
    }
  | { readonly kind: "legacy-site"; readonly pointerKey: string }
);

function artifactDeliveryKey(
  brand: PublicBrand,
  kind: "file" | "html",
  alias: string,
): string {
  if (kind === "file")
    return `artifact-delivery/files/${encodeURIComponent(alias)}.json`;
  return `artifact-delivery/${brand}/html/${encodeURIComponent(alias)}.json`;
}
function artifactDeliveryRegistrationKey(brand: PublicBrand): string {
  return `artifact-delivery/${brand}/registration.json`;
}

interface Options {
  readonly publicBucket: string;
  readonly hostedBucket: string;
  readonly migrate: boolean;
  readonly verify: boolean;
  readonly finalize: boolean;
  readonly maxObjects: number;
  readonly concurrency?: number;
  readonly onProgress?: (phase: string, completed: number) => void;
  readonly resolveMissingContentType?: (
    key: string,
  ) => Promise<string | undefined>;
}
interface Entry {
  readonly key: string;
  readonly record: HistoricalPublicRecord;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)
  );
}

async function readJson(client: S3Client, bucket: string, key: string) {
  try {
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!result.Body) throw new Error(`Missing object body: ${key}`);
    const text = await result.Body.transformToString();
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function* keys(
  client: S3Client,
  bucket: string,
  prefix: string,
  limit: number,
) {
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: cursor,
        MaxKeys: 1000,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key)
        throw new Error("R2 list returned an object without a key");
      if (++count > limit)
        throw new Error(
          "Inventory limit reached; increase --max-objects before retrying",
        );
      yield object.Key;
    }
    if (page.IsTruncated && !page.NextContinuationToken)
      throw new Error("R2 inventory pagination is incomplete");
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (cursor);
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid historical pointer or manifest");
  return value as Record<string, unknown>;
}

async function pendingMultipartRegistrations(
  publicClient: S3Client,
  hostedClient: S3Client,
  options: Options,
) {
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  let pending = 0;
  let unregistered = 0;
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
    await forEachConcurrent(
      page.Uploads ?? [],
      options.concurrency ?? 16,
      async (upload) => {
        const key = upload.Key;
        if (!key?.startsWith("artifacts/") || !upload.UploadId)
          throw new Error("Invalid pending multipart upload identity");
        if (++pending > options.maxObjects)
          throw new Error("Pending multipart upload inventory limit reached");
        const value = await readJson(
          hostedClient,
          options.hostedBucket,
          artifactDeliveryKey("vm0", "file", key.slice("artifacts/".length)),
        );
        if (value === undefined) {
          unregistered++;
          return;
        }
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
      },
    );
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
  return { pending, unregistered };
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field)
    throw new Error(`Invalid historical ${key}`);
  return field;
}

async function historicalSiteEntry(
  hostedClient: S3Client,
  options: Options,
  key: string,
) {
  const match =
    /^sites\/(?:brands\/(okou)\/)?(?:([^/]+)\/active\.json|deployments\/([^/]+)\.json)$/u.exec(
      key,
    );
  if (!match) return null;
  const pointer = objectRecord(
    await readJson(hostedClient, options.hostedBucket, key),
  );
  const brand = match[1] === "okou" ? "okou" : "vm0";
  if ((pointer.publicBrand ?? "vm0") !== brand || pointer.version !== 1)
    throw new Error("Historical pointer brand/version mismatch");
  const prefix = stringField(pointer, "prefix");
  const manifestKey = stringField(pointer, "manifestKey");
  if (!prefix.startsWith("sites/") || manifestKey !== `${prefix}/manifest.json`)
    throw new Error(
      "Historical pointer does not address a public site namespace",
    );
  const manifest = objectRecord(
    await readJson(hostedClient, options.hostedBucket, manifestKey),
  );
  if (manifest.access !== undefined) {
    return { skipped: true as const };
  }
  const deploymentId = stringField(pointer, "deploymentId");
  const publicSlug = stringField(pointer, "publicSlug");
  if (
    manifest.version !== 1 ||
    manifest.deploymentId !== deploymentId ||
    manifest.siteId !== pointer.siteId ||
    manifest.publicSlug !== publicSlug ||
    (manifest.publicBrand ?? "vm0") !== brand ||
    (match[2] && match[2] !== publicSlug) ||
    (match[3] && match[3] !== deploymentId)
  )
    throw new Error("Historical pointer does not match its manifest or alias");
  const alias = match[3] ? `dpl-${deploymentId}` : publicSlug;
  const record: HistoricalPublicRecord = {
    version: 1,
    kind: "legacy-site",
    publicBrand: brand,
    audience: "public",
    pointerKey: key,
  };
  return {
    skipped: false as const,
    deploymentId,
    entry: { key: artifactDeliveryKey(brand, "html", alias), record },
  };
}

async function registeredContentType(
  hostedClient: S3Client,
  options: Options,
  key: string,
  brand: PublicBrand,
  filename: string,
) {
  const value = await readJson(
    hostedClient,
    options.hostedBucket,
    artifactDeliveryKey(brand, "file", key.slice("artifacts/".length)),
  );
  if (value === undefined) return undefined;
  const record = objectRecord(value);
  if (
    record.version !== 1 ||
    record.kind !== "legacy-file" ||
    record.audience !== "public" ||
    record.key !== key ||
    record.publicBrand !== brand ||
    record.filename !== filename ||
    typeof record.contentType !== "string" ||
    !record.contentType
  ) {
    throw new Error(
      "Existing registration cannot resolve missing public MIME metadata",
    );
  }
  return record.contentType;
}

/** Enumerate only the historical public artifact namespace and public pointers. */
async function inventory(
  publicClient: S3Client,
  hostedClient: S3Client,
  options: Options,
) {
  const entries = new Map<string, Entry>();
  const sourceFiles = new Set<string>();
  const sourceDeployments = new Set<string>();
  let skipped = 0;
  function add(entry: Entry) {
    const previous = entries.get(entry.key);
    if (
      previous &&
      JSON.stringify(previous.record) !== JSON.stringify(entry.record)
    )
      throw new Error("Conflicting historical aliases");
    entries.set(entry.key, entry);
  }
  let scannedFiles = 0;
  let resolvedContentTypes = 0;
  await forEachConcurrent(
    keys(publicClient, options.publicBucket, "artifacts/", options.maxObjects),
    options.concurrency ?? 16,
    async (key) => {
      // The draft namespace is also present in the existing public bucket.
      // Private metadata and database ownership are checked before any write.
      if (
        !/^artifacts\/(?:[a-z0-9]{10}\.[^/]+|[^/]+\/[^/]+\/[^/]+|html-edit-drafts\/[0-9a-f-]{36}\.html)$/u.test(
          key,
        )
      ) {
        skipped++;
        return;
      }
      const head = await publicClient.send(
        new HeadObjectCommand({ Bucket: options.publicBucket, Key: key }),
      );
      if (
        head.Metadata?.storage === "private-artifact-v1" ||
        head.Metadata?.access === "owner-private-v1"
      )
        throw new Error(
          "Private metadata found in historical public storage; investigate without publishing it",
        );
      const brand = head.Metadata?.["public-brand"] ?? "vm0";
      if (brand !== "okou" && brand !== "vm0")
        throw new Error("Invalid historical artifact brand");
      const filename = head.Metadata?.filename
        ? decodeURIComponent(head.Metadata.filename)
        : decodeURIComponent(key.slice(key.lastIndexOf("/") + 1));
      // Desktop click tracks can lack R2 HTTP metadata. A pre-registration
      // remains authoritative even if an upload has not completed in the DB.
      const contentType =
        head.ContentType ??
        (await registeredContentType(
          hostedClient,
          options,
          key,
          brand,
          filename,
        )) ??
        (await options.resolveMissingContentType?.(key)) ??
        (await resolveLegacyClickTrackContentType(
          publicClient,
          options.publicBucket,
          key,
          filename,
          head,
        ));
      if (!contentType)
        throw new Error(`Historical artifact has no content type: ${key}`);
      if (!head.ContentType) resolvedContentTypes++;
      const record: HistoricalPublicRecord = {
        version: 1,
        kind: "legacy-file",
        publicBrand: brand,
        audience: "public",
        key,
        filename,
        contentType,
      };
      sourceFiles.add(key);
      add({
        key: artifactDeliveryKey(brand, "file", key.slice("artifacts/".length)),
        record,
      });
      scannedFiles++;
      if (scannedFiles % 1000 === 0)
        options.onProgress?.("inventory-files", scannedFiles);
    },
  );
  await forEachConcurrent(
    keys(hostedClient, options.hostedBucket, "sites/", options.maxObjects),
    options.concurrency ?? 16,
    async (key) => {
      const site = await historicalSiteEntry(hostedClient, options, key);
      if (!site) return;
      if (site.skipped) {
        skipped++;
        return;
      }
      sourceDeployments.add(site.deploymentId);
      add(site.entry);
    },
  );
  return {
    entries,
    sourceFiles,
    sourceDeployments,
    skipped,
    resolvedContentTypes,
  };
}

function digest(entries: ReadonlyMap<string, Entry>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...entries].sort(([a], [b]) => {
          return a.localeCompare(b);
        }),
      ),
    )
    .digest("hex");
}

class RegistrationConflictError extends Error {
  constructor(
    readonly report: {
      readonly status: "blocked";
      readonly files: number;
      readonly deployments: number;
      readonly aliases: number;
      readonly conflicts: readonly string[];
    },
  ) {
    super(
      `Historical Public registration has ${report.conflicts.length} conflicts; use --report for the alias inventory`,
    );
  }
}

async function readExistingAliases(
  hostedClient: S3Client,
  options: Options,
  initial: Awaited<ReturnType<typeof inventory>>,
) {
  const previousRecords = new Map<string, unknown>();
  const conflicts: string[] = [];
  let checked = 0;
  await forEachConcurrent(
    initial.entries.values(),
    options.concurrency ?? 16,
    async (entry) => {
      const previous = await readJson(
        hostedClient,
        options.hostedBucket,
        entry.key,
      );
      previousRecords.set(entry.key, previous);
      if (previous !== undefined && !isDeepStrictEqual(previous, entry.record))
        conflicts.push(entry.key);
      if (++checked % 1000 === 0)
        options.onProgress?.("check-existing-aliases", checked);
    },
  );
  if (conflicts.length)
    throw new RegistrationConflictError({
      status: "blocked",
      files: initial.sourceFiles.size,
      deployments: initial.sourceDeployments.size,
      aliases: initial.entries.size,
      conflicts,
    });
  return previousRecords;
}

/** API/CLI-driven writes continue to register while this idempotent pass runs. */
function validateOptions(options: Options) {
  const concurrency = options.concurrency ?? 16;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new Error("Concurrency must be between 1 and 64");
  if (options.finalize && (!options.migrate || !options.verify))
    throw new Error("--finalize requires --migrate --verify");
}

export async function registerHistoricalPublicArtifacts(
  publicClient: S3Client,
  hostedClient: S3Client,
  options: Options,
  reconcile: (
    files: ReadonlySet<string>,
    deployments: ReadonlySet<string>,
  ) => Promise<void>,
) {
  validateOptions(options);
  const initial = await inventory(publicClient, hostedClient, options);
  await reconcile(initial.sourceFiles, initial.sourceDeployments);
  const previousRecords = await readExistingAliases(
    hostedClient,
    options,
    initial,
  );
  let existing = 0;
  let registered = 0;
  let processed = 0;
  await forEachConcurrent(
    initial.entries.values(),
    options.concurrency ?? 16,
    async (entry) => {
      const previous = previousRecords.get(entry.key);
      const body = JSON.stringify(entry.record);
      if (previous !== undefined) {
        existing++;
      } else if (options.migrate) {
        try {
          await hostedClient.send(
            new PutObjectCommand({
              Bucket: options.hostedBucket,
              Key: entry.key,
              Body: body,
              ContentType: "application/json",
              IfNoneMatch: "*",
            }),
          );
          registered++;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "PreconditionFailed")
            throw error;
          const concurrent = await readJson(
            hostedClient,
            options.hostedBucket,
            entry.key,
          );
          if (!isDeepStrictEqual(concurrent, entry.record))
            throw new Error(
              "Concurrent alias registration conflicts with the inventory",
            );
          existing++;
        }
      }
      if (options.verify || options.migrate) {
        const actual = await readJson(
          hostedClient,
          options.hostedBucket,
          entry.key,
        );
        if (!isDeepStrictEqual(actual, entry.record))
          throw new Error("Public registration read-back failed");
      }
      processed++;
      if (processed % 1000 === 0)
        options.onProgress?.("registration", processed);
    },
  );
  // Parts can be completed long after their PUT signatures expire. Check them
  // before the final object inventory so an old session completing during this
  // boundary is either blocked here or included in the final object coverage.
  const multipart = await pendingMultipartRegistrations(
    publicClient,
    hostedClient,
    options,
  );
  const final = await inventory(publicClient, hostedClient, options);
  await reconcile(final.sourceFiles, final.sourceDeployments);
  // Online writers register before exposing objects. Accept concurrent additions
  // only after independently verifying their exact records in the final inventory.
  const finalRecords = await readExistingAliases(hostedClient, options, final);
  const missing = [...final.entries.keys()].filter((key) => {
    return finalRecords.get(key) === undefined;
  }).length;
  if ((options.migrate || options.verify) && missing > 0) {
    throw new Error(
      "Final inventory contains unregistered public artifacts; rerun to repair missing aliases",
    );
  }
  if ((options.migrate || options.verify) && final.skipped > 0)
    throw new Error(
      "Unclassified historical artifact objects require reconciliation before verification",
    );
  if ((options.migrate || options.verify) && multipart.unregistered > 0)
    throw new Error(
      `${multipart.unregistered} unregistered multipart uploads must finish or expire before coverage can be accepted`,
    );
  const inventoryHash = digest(final.entries);
  if (options.finalize) {
    const marker = JSON.stringify({
      version: 1,
      complete: true,
      inventoryHash,
      count: final.entries.size,
      completedAt: new Date().toISOString(),
    });
    for (const brand of ["vm0", "okou"] as const) {
      const key = artifactDeliveryRegistrationKey(brand);
      await hostedClient.send(
        new PutObjectCommand({
          Bucket: options.hostedBucket,
          Key: key,
          Body: marker,
          ContentType: "application/json",
        }),
      );
      if (
        JSON.stringify(
          await readJson(hostedClient, options.hostedBucket, key),
        ) !== marker
      )
        throw new Error("Registration completion marker read-back failed");
    }
  }
  return {
    inventoryHash,
    files: initial.sourceFiles.size,
    deployments: initial.sourceDeployments.size,
    aliases: initial.entries.size,
    existing,
    registered,
    skipped: final.skipped,
    missing,
    finalFiles: final.sourceFiles.size,
    finalAliases: final.entries.size,
    resolvedContentTypes: final.resolvedContentTypes,
    pendingMultipartUploads: multipart.pending,
    unregisteredMultipartUploads: multipart.unregistered,
    verified: options.verify || options.migrate,
    finalized: options.finalize,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const { values } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      finalize: { type: "boolean", default: false },
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
  const maxObjects = Number(values["max-objects"]);
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1)
    throw new Error("--max-objects must be a positive integer");
  const db = postgres(required("DATABASE_URL"), {
    max: 1,
    connection: {
      default_transaction_read_only: true,
      statement_timeout: 30000,
    },
  });
  try {
    const report = await registerHistoricalPublicArtifacts(
      publicClient,
      hostedClient,
      {
        publicBucket: required("R2_USER_ARTIFACTS_BUCKET_NAME"),
        hostedBucket: required("R2_HOSTED_SITES_BUCKET_NAME"),
        migrate: values.migrate,
        verify: values.verify,
        finalize: values.finalize,
        maxObjects,
        concurrency: Number(values.concurrency),
        onProgress: (phase, completed) => {
          console.error(JSON.stringify({ phase, completed }));
        },
        resolveMissingContentType: async (key) => {
          const rows =
            await db`select distinct content_type from run_uploaded_files where storage_key = ${key} and content_type is not null`;
          if (rows.length > 1)
            throw new Error(
              `Historical artifact has conflicting database content types: ${key}`,
            );
          if (rows.length !== 1 || typeof rows[0]?.content_type !== "string")
            return undefined;
          return rows[0].content_type;
        },
      },
      async (files, deployments) => {
        const privateRows =
          await db`select storage_key from run_uploaded_files where metadata->>'storage' = 'private-artifact-v1' and storage_key is not null`;
        if (
          privateRows.some((row) => {
            if (typeof row.storage_key !== "string")
              throw new Error(
                "Invalid private artifact storage key in database reconciliation",
              );
            return files.has(row.storage_key);
          })
        )
          throw new Error(
            "Inventory overlaps private artifact ownership records",
          );
        for (const id of deployments) {
          const rows =
            await db`select d.status, s.deleted_at from hosted_deployments d join hosted_sites s on s.id = d.site_id where d.id = ${id}`;
          if (
            rows.length !== 1 ||
            rows[0]?.status !== "ready" ||
            rows[0].deleted_at !== null
          )
            throw new Error(
              "A public site pointer is missing, deleted or not ready in the authoritative database; reconcile before registering it",
            );
        }
      },
    );
    if (values.report)
      await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  } catch (error) {
    if (values.report && error instanceof RegistrationConflictError)
      await writeFile(
        values.report,
        `${JSON.stringify(error.report, null, 2)}\n`,
      );
    throw error;
  } finally {
    await db.end();
    publicClient.destroy();
    hostedClient.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
