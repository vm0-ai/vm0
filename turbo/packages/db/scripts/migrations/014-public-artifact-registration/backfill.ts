import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";
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
  for await (const key of keys(
    publicClient,
    options.publicBucket,
    "artifacts/",
    options.maxObjects,
  )) {
    // These are the two key shapes emitted by historical artifact writers.
    if (
      !/^artifacts\/(?:[a-z0-9]{10}\.[^/]+|[^/]+\/[^/]+\/[^/]+)$/u.test(key)
    ) {
      skipped++;
      continue;
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
    if (!head.ContentType)
      throw new Error(`Historical artifact has no content type: ${key}`);
    const record: HistoricalPublicRecord = {
      version: 1,
      kind: "legacy-file",
      publicBrand: brand,
      audience: "public",
      key,
      filename,
      contentType: head.ContentType,
    };
    sourceFiles.add(key);
    add({
      key: artifactDeliveryKey(brand, "file", key.slice("artifacts/".length)),
      record,
    });
  }
  for await (const key of keys(
    hostedClient,
    options.hostedBucket,
    "sites/",
    options.maxObjects,
  )) {
    const site = await historicalSiteEntry(hostedClient, options, key);
    if (!site) continue;
    if (site.skipped) {
      skipped++;
      continue;
    }
    sourceDeployments.add(site.deploymentId);
    add(site.entry);
  }
  return { entries, sourceFiles, sourceDeployments, skipped };
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
  for (const entry of initial.entries.values()) {
    const previous = await readJson(
      hostedClient,
      options.hostedBucket,
      entry.key,
    );
    previousRecords.set(entry.key, previous);
    if (previous !== undefined && !isDeepStrictEqual(previous, entry.record))
      conflicts.push(entry.key);
  }
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
export async function registerHistoricalPublicArtifacts(
  publicClient: S3Client,
  hostedClient: S3Client,
  options: Options,
  reconcile: (
    files: ReadonlySet<string>,
    deployments: ReadonlySet<string>,
  ) => Promise<void>,
) {
  if (options.finalize && (!options.migrate || !options.verify))
    throw new Error("--finalize requires --migrate --verify");
  const initial = await inventory(publicClient, hostedClient, options);
  await reconcile(initial.sourceFiles, initial.sourceDeployments);
  const previousRecords = await readExistingAliases(
    hostedClient,
    options,
    initial,
  );
  let existing = 0;
  let registered = 0;
  for (const entry of initial.entries.values()) {
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
  }
  const final = await inventory(publicClient, hostedClient, options);
  await reconcile(final.sourceFiles, final.sourceDeployments);
  const inventoryHash = digest(initial.entries);
  if (inventoryHash !== digest(final.entries))
    throw new Error(
      "Historical inventory changed during registration; rerun to include concurrent writes",
    );
  if (options.finalize) {
    if (initial.skipped > 0)
      throw new Error(
        "Unclassified historical artifact objects require reconciliation before finalization",
      );
    const marker = JSON.stringify({
      version: 1,
      complete: true,
      inventoryHash,
      count: initial.entries.size,
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
    skipped: initial.skipped,
    missing: initial.entries.size - existing - registered,
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
