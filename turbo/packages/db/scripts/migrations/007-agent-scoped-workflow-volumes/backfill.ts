#!/usr/bin/env tsx

/**
 * Agent-scoped workflow redesign — R2 volume re-key + instruction backfill.
 *
 * Companion data migration for SQL migration `0480_agent_scoped_workflows`
 * (issue vm0-ai/vm0#18434). The SQL migration already:
 *   - gave every `zero_workflows` row an `agent_id`,
 *   - duplicated multi-bound workflows into one row per agent (new uuids,
 *     SAME `name`),
 *   - deleted true-orphan workflows,
 *   - dropped `zero_workflow_agents`.
 *
 * What SQL could NOT do (needs object-storage I/O) is the work in THIS script:
 *
 *   1. Re-key volumes to workflow id. Historically a workflow's content lived
 *      in an org volume named `custom-skill@{name}`. The new code keys volumes
 *      by workflow id (`custom-skill@{id}`). For every current workflow row we
 *      ensure an id-keyed volume exists, sourced from the legacy name-keyed
 *      volume. Because duplicated rows SHARE a `name`, each id-keyed row gets
 *      its OWN copy under its OWN s3Prefix — they never share storage.
 *
 *   2. Backfill `instruction`. The DB is now the source of truth for a
 *      workflow's instruction body. For each row whose `instruction` is null we
 *      read the id-keyed volume's SKILL.md, strip the frontmatter via
 *      `extractInstructionFromSkillMd`, and persist the body.
 *
 *   3. Preserve legacy name-keyed volumes by default. A later explicit
 *      `--cleanup-legacy` run is deletion-only: it verifies each current
 *      workflow has an id-keyed volume, preserves legacy volumes for any
 *      workflow that does not, and deletes the remaining legacy volumes.
 *
 * The script is idempotent and defaults to dry-run. It only mutates when
 * `--migrate` is passed. Legacy name-keyed volumes are preserved by default;
 * pass `--cleanup-legacy` in a later cleanup run to delete them.
 *
 * Usage (from turbo/packages/db):
 *   pnpm exec tsx scripts/migrations/007-agent-scoped-workflow-volumes/backfill.ts --preseed
 *   pnpm exec tsx scripts/migrations/007-agent-scoped-workflow-volumes/backfill.ts --preseed --migrate
 *   pnpm exec tsx scripts/migrations/007-agent-scoped-workflow-volumes/backfill.ts
 *   pnpm exec tsx scripts/migrations/007-agent-scoped-workflow-volumes/backfill.ts --migrate
 *   pnpm exec tsx scripts/migrations/007-agent-scoped-workflow-volumes/backfill.ts --migrate --cleanup-legacy
 *   pnpm exec tsx scripts/migrations/007-agent-scoped-workflow-volumes/backfill.ts --migrate --org=org_xxx
 *
 * Environment:
 *   DATABASE_URL                  — Required
 *   R2_USER_STORAGES_BUCKET_NAME  — Required (workflow volume bucket)
 *   R2_ACCOUNT_ID                 — Required (unless S3_ENDPOINT is set)
 *   R2_ACCESS_KEY_ID              — Required
 *   R2_SECRET_ACCESS_KEY          — Required
 *   S3_ENDPOINT                   — Optional (overrides the R2 account endpoint)
 *   S3_REGION                     — Optional (defaults to "auto")
 *   S3_FORCE_PATH_STYLE           — Optional ("true" | "false")
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";

import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  extractInstructionFromSkillMd,
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
    org: { type: "string" },
    preseed: { type: "boolean", default: false },
    "cleanup-legacy": { type: "boolean", default: false },
  },
  strict: true,
});

const DRY_RUN = !args.migrate;
const SINGLE_ORG_ID = args.org;
const PRESEED = args.preseed === true;
const CLEANUP_LEGACY = args["cleanup-legacy"] === true;
const PHASE = PRESEED
  ? "preseed (volume sync only, pre-0480 compatible)"
  : CLEANUP_LEGACY
    ? "cleanup (delete legacy volumes only)"
    : "post-0480 backfill";

if (PRESEED && CLEANUP_LEGACY) {
  throw new Error("--preseed cannot be combined with --cleanup-legacy");
}

const SKILL_FILENAME = "SKILL.md";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof drizzle>;

interface WorkflowRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly description: string | null;
  readonly instruction: string | null;
}

interface VolumeRow {
  readonly id: string;
  readonly s3Prefix: string;
  readonly headVersionId: string | null;
}

interface VersionRow {
  readonly id: string;
  readonly s3Key: string;
  readonly size: number;
  readonly fileCount: number;
  readonly message: string | null;
  readonly createdBy: string;
}

interface S3ManifestFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

interface S3Manifest {
  readonly version: string;
  readonly createdAt: string;
  readonly totalSize: number;
  readonly fileCount: number;
  readonly files: readonly S3ManifestFile[];
}

interface Stats {
  workflows: number;
  volumesCopied: number;
  volumesSynced: number;
  volumesAlreadyKeyed: number;
  legacyMissing: number;
  cleanupIdVolumesMissing: number;
  instructionsBackfilled: number;
  instructionsSkipped: number;
  legacyVolumesDeleted: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// S3 / R2 client (mirrors apps/api/src/signals/external/s3.ts construction)
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function createR2Client(): S3Client {
  const endpoint =
    process.env.S3_ENDPOINT ??
    `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
}

function s3CopySource(bucket: string, key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${bucket}/${encodedKey}`;
}

async function listObjectsUnderPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<readonly string[]> {
  const boundedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: boundedPrefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const item of response.Contents ?? []) {
      if (item.Key) {
        keys.push(item.Key);
      }
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

async function copyObject(
  client: S3Client,
  bucket: string,
  sourceKey: string,
  destinationKey: string,
): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: s3CopySource(bucket, sourceKey),
      Key: destinationKey,
    }),
  );
}

async function deleteObjects(
  client: S3Client,
  bucket: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  // DeleteObjects accepts at most 1000 keys per request.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => {
            return { Key };
          }),
        },
      }),
    );
  }
}

async function downloadBuffer(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) {
    throw new Error(`S3 object body is empty: ${key}`);
  }
  const chunks: Buffer[] = [];
  const stream = response.Body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadManifestJson(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<S3Manifest> {
  const content = await downloadBuffer(client, bucket, key);
  return JSON.parse(content.toString("utf8")) as S3Manifest;
}

function computeStorageVersionId(
  storageId: string,
  files: readonly S3ManifestFile[],
): string {
  if (files.length === 0) {
    return createHash("sha256").update(`storage:${storageId}\n`).digest("hex");
  }

  const entries = files
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();

  return createHash("sha256")
    .update(`storage:${storageId}\n${entries.join("\n")}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Minimal tar reader (mirrors apps/api/src/lib/tar.ts — pure node:zlib, no deps)
// ---------------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512;

function normalizeTarPath(path: string): string {
  return path.replace(/^\.\//, "");
}

function readTarString(buffer: Buffer, start: number, end: number): string {
  const slice = buffer.subarray(start, end);
  const nullIndex = slice.indexOf(0);
  return slice
    .subarray(0, nullIndex !== -1 ? nullIndex : slice.length)
    .toString("utf8");
}

function readTarPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 500);
  return normalizeTarPath(prefix ? `${prefix}/${name}` : name);
}

function extractFileFromTarGz(
  gzBuffer: Buffer,
  targetPath: string,
): string | null {
  const target = normalizeTarPath(targetPath);
  const tarBuffer = gunzipSync(gzBuffer);
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (
      header.every((b) => {
        return b === 0;
      })
    ) {
      break;
    }
    const name = readTarPath(header);
    const sizeStr = header.subarray(124, 136).toString("utf8").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;
    const typeFlag = readTarString(header, 156, 157);
    offset += TAR_BLOCK_SIZE;
    if ((typeFlag === "" || typeFlag === "0") && name === target) {
      return tarBuffer.subarray(offset, offset + size).toString("utf8");
    }
    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function lookupVolume(
  db: Db,
  orgId: string,
  storageName: string,
): Promise<VolumeRow | undefined> {
  return db
    .select({
      id: storages.id,
      s3Prefix: storages.s3Prefix,
      headVersionId: storages.headVersionId,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, storageName),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1)
    .then((rows) => {
      return rows[0];
    });
}

function lookupVersions(db: Db, storageId: string): Promise<VersionRow[]> {
  return db
    .select({
      id: storageVersions.id,
      s3Key: storageVersions.s3Key,
      size: storageVersions.size,
      fileCount: storageVersions.fileCount,
      message: storageVersions.message,
      createdBy: storageVersions.createdBy,
    })
    .from(storageVersions)
    .where(eq(storageVersions.storageId, storageId))
    .orderBy(asc(storageVersions.createdAt));
}

// ---------------------------------------------------------------------------
// Step 1: Re-key a single workflow's volume to its id
// ---------------------------------------------------------------------------

interface RekeyResult {
  readonly status: "copied" | "synced" | "already-keyed" | "legacy-missing";
  readonly idVolumeS3Prefix: string | null;
}

interface SyncResult {
  readonly changed: boolean;
  readonly versionCount: number;
}

async function storageVersionExists(
  db: Db,
  storageId: string,
  versionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: storageVersions.id })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storageId),
        eq(storageVersions.id, versionId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function copyLegacyVersionsToStorage(
  db: Db,
  client: S3Client,
  bucket: string,
  legacy: VolumeRow,
  target: VolumeRow,
): Promise<SyncResult> {
  const legacyVersions = await lookupVersions(db, legacy.id);
  let headVersionId: string | null = null;
  let headSize = 0;
  let headFileCount = 0;
  let changed = false;

  for (const version of legacyVersions) {
    const manifest = await downloadManifestJson(
      client,
      bucket,
      `${version.s3Key}/manifest.json`,
    );
    const newVersionId = computeStorageVersionId(target.id, manifest.files);
    const newS3Key = `${target.s3Prefix}/${newVersionId}`;

    if (version.id === legacy.headVersionId) {
      headVersionId = newVersionId;
      headSize = version.size;
      headFileCount = version.fileCount;
    }

    if (DRY_RUN) {
      continue;
    }

    if (await storageVersionExists(db, target.id, newVersionId)) {
      continue;
    }

    const sourceObjects = await listObjectsUnderPrefix(
      client,
      bucket,
      version.s3Key,
    );
    for (const sourceKey of sourceObjects) {
      const suffix = sourceKey.slice(version.s3Key.length);
      await copyObject(client, bucket, sourceKey, `${newS3Key}${suffix}`);
    }

    await db
      .insert(storageVersions)
      .values({
        id: newVersionId,
        storageId: target.id,
        s3Key: newS3Key,
        size: version.size,
        fileCount: version.fileCount,
        message: version.message,
        createdBy: version.createdBy,
      })
      .onConflictDoNothing();
    changed = true;
  }

  if (target.headVersionId !== headVersionId) {
    changed = true;
  }

  if (!DRY_RUN && changed) {
    await db
      .update(storages)
      .set({
        headVersionId,
        size: headSize,
        fileCount: headFileCount,
      })
      .where(eq(storages.id, target.id));
  }

  return {
    changed,
    versionCount: legacyVersions.length,
  };
}

/**
 * Ensure the id-keyed volume `custom-skill@{id}` exists for a workflow,
 * sourcing its content from the legacy `custom-skill@{name}` volume.
 *
 * Always copies into a fresh, id-scoped s3Prefix so duplicated rows that share
 * a name never share storage. Idempotent: re-running detects the existing
 * id-keyed volume and syncs it forward when the legacy head changed after a
 * preseed run.
 */
async function rekeyWorkflowVolume(
  db: Db,
  client: S3Client,
  bucket: string,
  workflow: WorkflowRow,
): Promise<RekeyResult> {
  const idStorageName = getCustomSkillStorageName(workflow.id);
  const existing = await lookupVolume(db, workflow.orgId, idStorageName);
  const legacyStorageName = getCustomSkillStorageName(workflow.name);
  const legacy = await lookupVolume(db, workflow.orgId, legacyStorageName);
  if (!legacy) {
    if (existing) {
      return { status: "already-keyed", idVolumeS3Prefix: existing.s3Prefix };
    }
    return { status: "legacy-missing", idVolumeS3Prefix: null };
  }

  if (existing) {
    const sync = await copyLegacyVersionsToStorage(
      db,
      client,
      bucket,
      legacy,
      existing,
    );
    if (!sync.changed) {
      return { status: "already-keyed", idVolumeS3Prefix: existing.s3Prefix };
    }
    console.log(
      `      ${DRY_RUN ? "would sync" : "synced"} existing id-keyed volume ` +
        `"${idStorageName}" from legacy "${legacyStorageName}" ` +
        `(${sync.versionCount} version(s))`,
    );
    return { status: "synced", idVolumeS3Prefix: existing.s3Prefix };
  }

  const newPrefix = `${workflow.orgId}/volume/${idStorageName}`;

  if (DRY_RUN) {
    const legacyVersions = await lookupVersions(db, legacy.id);
    console.log(
      `      would copy legacy volume "${legacyStorageName}" → "${idStorageName}" ` +
        `(${legacyVersions.length} version(s), new prefix ${newPrefix})`,
    );
    return { status: "copied", idVolumeS3Prefix: newPrefix };
  }

  // Create the id-keyed storages row first (without head pointer).
  const [newStorage] = await db
    .insert(storages)
    .values({
      userId: VOLUME_ORG_USER_ID,
      orgId: workflow.orgId,
      name: idStorageName,
      type: "volume",
      s3Prefix: newPrefix,
      size: 0,
      fileCount: 0,
    })
    .returning({ id: storages.id });
  if (!newStorage) {
    throw new Error(`Failed to create id-keyed storage for ${workflow.id}`);
  }

  const sync = await copyLegacyVersionsToStorage(db, client, bucket, legacy, {
    id: newStorage.id,
    s3Prefix: newPrefix,
    headVersionId: null,
  });

  console.log(
    `      copied legacy volume "${legacyStorageName}" → "${idStorageName}" ` +
      `(${sync.versionCount} version(s), prefix ${newPrefix})`,
  );
  return { status: "copied", idVolumeS3Prefix: newPrefix };
}

// ---------------------------------------------------------------------------
// Step 2: Backfill instruction from the id-keyed volume's SKILL.md
// ---------------------------------------------------------------------------

async function readSkillMdFromVolume(
  db: Db,
  client: S3Client,
  bucket: string,
  orgId: string,
  workflowId: string,
): Promise<string | null> {
  const volume = await lookupVolume(
    db,
    orgId,
    getCustomSkillStorageName(workflowId),
  );
  if (!volume?.headVersionId) {
    return null;
  }
  const [version] = await db
    .select({ s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, volume.id),
        eq(storageVersions.id, volume.headVersionId),
      ),
    )
    .limit(1);
  if (!version) {
    return null;
  }
  const archive = await downloadBuffer(
    client,
    bucket,
    `${version.s3Key}/archive.tar.gz`,
  );
  return extractFileFromTarGz(archive, SKILL_FILENAME);
}

async function backfillInstruction(
  db: Db,
  client: S3Client,
  bucket: string,
  workflow: WorkflowRow,
): Promise<"backfilled" | "skipped"> {
  if (workflow.instruction !== null) {
    return "skipped";
  }
  const skillMd = await readSkillMdFromVolume(
    db,
    client,
    bucket,
    workflow.orgId,
    workflow.id,
  );
  if (skillMd === null) {
    console.log(
      `      no SKILL.md found for ${workflow.id} — instruction left null`,
    );
    return "skipped";
  }
  const instruction = extractInstructionFromSkillMd(skillMd);
  if (instruction.length === 0) {
    console.log(
      `      SKILL.md for ${workflow.id} has empty body — instruction left null`,
    );
    return "skipped";
  }

  if (DRY_RUN) {
    console.log(
      `      would backfill instruction for ${workflow.id} (${instruction.length} chars)`,
    );
    return "backfilled";
  }

  await db
    .update(zeroWorkflows)
    .set({ instruction })
    .where(eq(zeroWorkflows.id, workflow.id));
  console.log(
    `      backfilled instruction for ${workflow.id} (${instruction.length} chars)`,
  );
  return "backfilled";
}

// ---------------------------------------------------------------------------
// Step 3: Delete legacy name-keyed volumes
// ---------------------------------------------------------------------------

async function deleteLegacyVolumes(
  db: Db,
  client: S3Client,
  bucket: string,
  orgId: string,
  preserveLegacyNames: ReadonlySet<string>,
): Promise<number> {
  // All `custom-skill@*` volumes in the org.
  const allVolumes = await db
    .select({
      id: storages.id,
      name: storages.name,
      s3Prefix: storages.s3Prefix,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.type, "volume"),
      ),
    );

  // Names that correspond to a current workflow id (the new id-keyed volumes).
  const currentIdNames = new Set(
    (
      await db
        .select({ id: zeroWorkflows.id })
        .from(zeroWorkflows)
        .where(eq(zeroWorkflows.orgId, orgId))
    ).map((w) => {
      return getCustomSkillStorageName(w.id);
    }),
  );

  let deleted = 0;
  for (const volume of allVolumes) {
    if (!volume.name.startsWith("custom-skill@")) {
      continue;
    }
    // Keep id-keyed volumes for current workflows.
    if (currentIdNames.has(volume.name)) {
      continue;
    }
    // Keep legacy name-keyed volumes when a current workflow does not yet have
    // its id-keyed volume. Cleanup must not delete the only available copy.
    if (preserveLegacyNames.has(volume.name)) {
      continue;
    }

    const objects = await listObjectsUnderPrefix(
      client,
      bucket,
      volume.s3Prefix,
    );

    if (DRY_RUN) {
      console.log(
        `    would delete legacy volume "${volume.name}" ` +
          `(${objects.length} S3 object(s), prefix ${volume.s3Prefix})`,
      );
      deleted++;
      continue;
    }

    await deleteObjects(client, bucket, objects);
    // storage_versions cascade-delete on storages deletion (FK onDelete).
    await db.delete(storages).where(eq(storages.id, volume.id));
    console.log(
      `    deleted legacy volume "${volume.name}" ` +
        `(${objects.length} S3 object(s))`,
    );
    deleted++;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Per-org processing
// ---------------------------------------------------------------------------

async function loadWorkflows(db: Db, orgId: string): Promise<WorkflowRow[]> {
  if (PRESEED) {
    const rows = await db
      .select({
        id: zeroWorkflows.id,
        orgId: zeroWorkflows.orgId,
        name: zeroWorkflows.name,
      })
      .from(zeroWorkflows)
      .where(eq(zeroWorkflows.orgId, orgId))
      .orderBy(asc(zeroWorkflows.createdAt));

    return rows.map((row) => {
      return { ...row, description: null, instruction: null };
    });
  }

  return await db
    .select({
      id: zeroWorkflows.id,
      orgId: zeroWorkflows.orgId,
      name: zeroWorkflows.name,
      description: zeroWorkflows.description,
      instruction: zeroWorkflows.instruction,
    })
    .from(zeroWorkflows)
    .where(eq(zeroWorkflows.orgId, orgId))
    .orderBy(asc(zeroWorkflows.createdAt));
}

async function processOrg(
  db: Db,
  client: S3Client,
  bucket: string,
  orgId: string,
  stats: Stats,
): Promise<void> {
  const workflows = await loadWorkflows(db, orgId);

  console.log(`\n  Org ${orgId} — ${workflows.length} workflow(s)`);
  stats.workflows += workflows.length;

  // Legacy names to keep during an explicit cleanup run because their workflow
  // does not have an id-keyed volume yet.
  const preserveLegacyNames = new Set<string>();

  if (CLEANUP_LEGACY) {
    for (const workflow of workflows) {
      console.log(`    workflow ${workflow.id} ("${workflow.name}")`);
      const idStorageName = getCustomSkillStorageName(workflow.id);
      const legacyStorageName = getCustomSkillStorageName(workflow.name);
      try {
        const existing = await lookupVolume(db, workflow.orgId, idStorageName);
        if (existing) {
          stats.volumesAlreadyKeyed++;
          console.log(
            `      id-keyed volume "${idStorageName}" present — legacy eligible for cleanup`,
          );
        } else {
          stats.cleanupIdVolumesMissing++;
          preserveLegacyNames.add(legacyStorageName);
          console.log(
            `      id-keyed volume "${idStorageName}" not found — preserving legacy "${legacyStorageName}"`,
          );
        }
      } catch (err) {
        stats.errors++;
        preserveLegacyNames.add(legacyStorageName);
        const message = err instanceof Error ? err.message : String(err);
        console.error(`      ✗ cleanup check for ${workflow.id}: ${message}`);
      }
    }

    try {
      stats.legacyVolumesDeleted += await deleteLegacyVolumes(
        db,
        client,
        bucket,
        orgId,
        preserveLegacyNames,
      );
    } catch (err) {
      stats.errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`    ✗ legacy volume cleanup for ${orgId}: ${message}`);
    }
    return;
  }

  for (const workflow of workflows) {
    console.log(`    workflow ${workflow.id} ("${workflow.name}")`);
    try {
      // Step 1: re-key volume to id.
      const rekey = await rekeyWorkflowVolume(db, client, bucket, workflow);
      if (rekey.status === "already-keyed") {
        stats.volumesAlreadyKeyed++;
      } else if (rekey.status === "synced") {
        stats.volumesSynced++;
      } else if (rekey.status === "copied") {
        stats.volumesCopied++;
      } else {
        stats.legacyMissing++;
        preserveLegacyNames.add(getCustomSkillStorageName(workflow.name));
        console.log(
          `      legacy volume "${getCustomSkillStorageName(workflow.name)}" ` +
            `not found — skipping re-key & instruction backfill`,
        );
      }

      // Step 2: backfill instruction (needs the id-keyed volume to exist).
      if (PRESEED) {
        stats.instructionsSkipped++;
      } else if (rekey.status !== "legacy-missing") {
        const result = await backfillInstruction(db, client, bucket, workflow);
        if (result === "backfilled") {
          stats.instructionsBackfilled++;
        } else {
          stats.instructionsSkipped++;
        }
      } else {
        stats.instructionsSkipped++;
      }
    } catch (err) {
      stats.errors++;
      preserveLegacyNames.add(getCustomSkillStorageName(workflow.name));
      const message = err instanceof Error ? err.message : String(err);
      console.error(`      ✗ ${workflow.id}: ${message}`);
    }
  }

  console.log("    legacy cleanup disabled — preserving name-keyed volumes");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const bucket = requireEnv("R2_USER_STORAGES_BUCKET_NAME");

  console.log("=== Agent-scoped workflow volume re-key + instruction backfill ===");
  console.log(
    `Mode: ${DRY_RUN ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
  );
  console.log(`Phase: ${PHASE}`);
  console.log(
    `Legacy cleanup: ${CLEANUP_LEGACY ? "enabled" : "disabled (preserve legacy volumes)"}`,
  );
  if (SINGLE_ORG_ID) {
    console.log(`Target: ${SINGLE_ORG_ID} (single-org mode)`);
  }
  console.log();

  const pg = postgres(databaseUrl, { max: 1 });
  const db = drizzle(pg);
  const client = createR2Client();

  const stats: Stats = {
    workflows: 0,
    volumesCopied: 0,
    volumesSynced: 0,
    volumesAlreadyKeyed: 0,
    legacyMissing: 0,
    cleanupIdVolumesMissing: 0,
    instructionsBackfilled: 0,
    instructionsSkipped: 0,
    legacyVolumesDeleted: 0,
    errors: 0,
  };

  try {
    let orgIds: string[];
    if (SINGLE_ORG_ID) {
      orgIds = [SINGLE_ORG_ID];
    } else {
      const rows = await db
        .selectDistinct({ orgId: zeroWorkflows.orgId })
        .from(zeroWorkflows)
        .orderBy(asc(zeroWorkflows.orgId));
      orgIds = rows.map((r) => {
        return r.orgId;
      });
    }

    console.log(`Found ${orgIds.length} org(s) owning workflows`);

    for (const orgId of orgIds) {
      await processOrg(db, client, bucket, orgId, stats);
    }

    console.log("\n=== Summary ===");
    console.log(`Workflows processed:        ${stats.workflows}`);
    console.log(`Volumes copied (re-keyed):  ${stats.volumesCopied}`);
    console.log(`Volumes synced:             ${stats.volumesSynced}`);
    console.log(`Volumes already id-keyed:   ${stats.volumesAlreadyKeyed}`);
    console.log(`Legacy volume missing:      ${stats.legacyMissing}`);
    console.log(`Cleanup id volumes missing: ${stats.cleanupIdVolumesMissing}`);
    console.log(`Instructions backfilled:    ${stats.instructionsBackfilled}`);
    console.log(`Instructions skipped:       ${stats.instructionsSkipped}`);
    console.log(`Legacy volumes deleted:     ${stats.legacyVolumesDeleted}`);
    console.log(`Errors:                     ${stats.errors}`);

    if (DRY_RUN) {
      console.log("\n⚠ Dry run — no changes were made. Pass --migrate to execute.");
    }

    if (stats.errors > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pg.end();
    client.destroy();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
