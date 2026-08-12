import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  chatEventRowV4Schema,
  type ChatEventRowV4,
} from "@vm0/api-contracts/contracts/chat-event-rows";
import { command, type Computed } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatEventSearchWatermarks } from "@vm0/db/schema/chat-event-search";
import { chatEventSnapshots } from "@vm0/db/schema/chat-event-snapshot";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { env, optionalEnv } from "../../lib/env";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  listS3ObjectsPage,
  putImmutableS3Object,
  type S3Object,
} from "../external/s3";
import { settle } from "../utils";

type ComputedGetter = <T>(computedValue: Computed<T>) => T;

interface ChatEventSnapshotStats {
  readonly snapshots: number;
  readonly archivedEvents: number;
  readonly retiredSnapshotReferencesDeleted: number;
  readonly r2ObjectsScanned: number;
  readonly r2ObjectsMeasured: number;
  readonly r2ObjectsDeleted: number;
  readonly r2BytesMeasured: number;
  readonly r2BytesDeleted: number;
  readonly r2GcShardsScanned: number;
  readonly r2GcSubpartitionedShards: number;
  readonly snapshotHeads: number;
  readonly nonV4SnapshotHeads: number;
  readonly snapshotHeadVersions: readonly ChatEventSnapshotHeadVersion[];
}

interface ChatEventSnapshotHeadVersion {
  readonly archiveSchemaVersion: number;
  readonly heads: number;
}

interface ChatEventSnapshotConvergence {
  readonly snapshotHeads: number;
  readonly nonV4SnapshotHeads: number;
  readonly snapshotHeadVersions: readonly ChatEventSnapshotHeadVersion[];
}

interface SnapshotCandidate {
  readonly chatThreadId: string;
  readonly indexedSeqId: number;
  readonly headId: string | null;
  readonly headLastSeqId: number | null;
  readonly headObjectKey: string | null;
  readonly headArchiveSchemaVersion: number | null;
}

/**
 * Version of the archive object contract. Bump it whenever the NDJSON line
 * shape (chatEventRowV4Schema) or the object encoding changes. v4 is the
 * canonical payload/run/context row shape and retains gzip content metadata
 * so browser downloads are transparently decompressed.
 */
export const ARCHIVE_SCHEMA_VERSION = 4;
/**
 * Old archive contracts below this version are no longer supported. Raise
 * this only after the App force-upgrade floor requires a reader that supports
 * the new minimum; changing the constant intentionally starts reclamation.
 */
const MIN_SUPPORTED_ARCHIVE_SCHEMA_VERSION = 4;
const ARCHIVE_CONTENT_TYPE = "application/x-ndjson";
const ARCHIVE_CONTENT_ENCODING = "gzip";
/**
 * At the 10-minute cron cadence this cap permits 144k changed threads per day.
 * Normal traffic re-archives roughly 700 active threads per day, so the cap
 * leaves ample room for bursts while keeping each invocation bounded.
 */
const DEFAULT_THREAD_BATCH_SIZE = 1000;
const EVENT_PAGE_SIZE = 1000;
const DEFAULT_R2_GC_GRACE_HOURS = 24 * 7;
const R2_GC_SHARDS_PER_RUN = 16;
const R2_GC_SHARD_COUNT = 16 ** 3;
const R2_GC_PAGE_SIZE = 1000;
const SNAPSHOT_GC_DELETE_QUOTA = 1000;
/**
 * Matches the cron cadence so every invocation advances to the next shard
 * window; the 4096 shards are swept in about 1.8 days.
 */
const R2_GC_SLOT_MS = 10 * 60 * 1000;
const HEX_DIGITS = "0123456789abcdef";

type ArchiveEventRow = Pick<
  typeof chatEvents.$inferSelect,
  | "id"
  | "chatThreadId"
  | "runId"
  | "revokesEventId"
  | "eventType"
  | "payload"
  | "contextType"
  | "contextId"
  | "runEventSequenceNumber"
  | "runEventId"
  | "seqId"
  | "createdAt"
>;

function chatEventSnapshotThreadBatchSize(): number {
  const raw = optionalEnv("CHAT_EVENT_SNAPSHOT_BATCH_SIZE");
  if (raw === undefined) {
    return DEFAULT_THREAD_BATCH_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "CHAT_EVENT_SNAPSHOT_BATCH_SIZE must be a positive integer",
    );
  }
  return parsed;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function booleanEnv(name: string, fallback = false): boolean {
  const raw = optionalEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function encodeArchiveLine(line: ChatEventRowV4): Buffer {
  return Buffer.from(`${JSON.stringify(line)}\n`);
}

/**
 * One canonical archived chat event, one NDJSON line. Fields are listed
 * explicitly so a chat_events schema change cannot silently alter the durable
 * wire shape. Physically retained rollout columns remain outside the v4
 * object until a later migration-order-safe contraction.
 */
export function chatEventRowFromDbRow(row: ArchiveEventRow): ChatEventRowV4 {
  return chatEventRowV4Schema.parse({
    id: row.id,
    chatThreadId: row.chatThreadId,
    runId: row.runId,
    revokesEventId: row.revokesEventId,
    eventType: row.eventType,
    payload: row.payload,
    contextType: row.contextType,
    contextId: row.contextId,
    runEventSequenceNumber: row.runEventSequenceNumber,
    runEventId: row.runEventId,
    seqId: row.seqId,
    createdAt: row.createdAt.toISOString(),
  });
}

function archiveLine(row: ArchiveEventRow): Buffer {
  return encodeArchiveLine(chatEventRowFromDbRow(row));
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function chatEventSnapshotObjectKey(
  chatThreadId: string,
  lastSeqId: number,
  contentSha256: string,
): string {
  return `chat-events/${chatThreadId}/${lastSeqId}-${contentSha256}.ndjson.gz`;
}

async function readCanonicalEvents(
  db: Db,
  candidate: SnapshotCandidate,
): Promise<{
  readonly lines: readonly Buffer[];
  readonly count: number;
  readonly lastSeqId: number;
}> {
  const lines: Buffer[] = [];
  let cursor = 0;
  let count = 0;
  for (;;) {
    const rows = await db
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        runId: chatEvents.runId,
        revokesEventId: chatEvents.revokesEventId,
        eventType: chatEvents.eventType,
        payload: chatEvents.payload,
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
        runEventSequenceNumber: chatEvents.runEventSequenceNumber,
        runEventId: chatEvents.runEventId,
        seqId: chatEvents.seqId,
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, candidate.chatThreadId),
          gt(chatEvents.seqId, cursor),
          lte(chatEvents.seqId, candidate.indexedSeqId),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(EVENT_PAGE_SIZE);
    for (const row of rows) {
      lines.push(archiveLine(row));
    }
    count += rows.length;
    const lastRow = rows[rows.length - 1];
    if (lastRow !== undefined) {
      cursor = lastRow.seqId;
    }
    if (rows.length < EVENT_PAGE_SIZE) {
      if (count === 0) {
        throw new Error(
          `chat event snapshot rebuild for ${candidate.chatThreadId} contained no events through indexed seq ${candidate.indexedSeqId.toString()}`,
        );
      }
      return { lines, count, lastSeqId: candidate.indexedSeqId };
    }
  }
}

/**
 * Atomically replaces the thread's head snapshot row. Returns false without
 * writing anything when another writer already advanced the head past the
 * expected parent; the freshly uploaded object then stays orphaned in R2.
 */
async function publishSnapshotHead(
  db: Db,
  candidate: SnapshotCandidate,
  lastSeqId: number,
  objectKey: string,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (candidate.headId !== null) {
      if (
        candidate.headLastSeqId === null ||
        candidate.headObjectKey === null ||
        candidate.headArchiveSchemaVersion === null
      ) {
        throw new Error("chat event snapshot head metadata is incomplete");
      }
      const demoted = await tx
        .update(chatEventSnapshots)
        .set({ isHead: false })
        .where(
          and(
            eq(chatEventSnapshots.id, candidate.headId),
            eq(chatEventSnapshots.chatThreadId, candidate.chatThreadId),
            eq(chatEventSnapshots.isHead, true),
            eq(
              chatEventSnapshots.archiveSchemaVersion,
              candidate.headArchiveSchemaVersion,
            ),
            eq(chatEventSnapshots.lastSeqId, candidate.headLastSeqId),
            eq(chatEventSnapshots.objectKey, candidate.headObjectKey),
          ),
        )
        .returning({ id: chatEventSnapshots.id });
      if (demoted.length === 0) {
        return false;
      }
    }
    await tx.insert(chatEventSnapshots).values({
      chatThreadId: candidate.chatThreadId,
      parentSnapshotId: candidate.headId,
      lastSeqId,
      archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
      objectKey,
      isHead: true,
    });
    return true;
  });
}

async function archiveThread(
  get: ComputedGetter,
  db: Db,
  bucket: string,
  candidate: SnapshotCandidate,
  signal: AbortSignal,
): Promise<number | null> {
  const archive = await readCanonicalEvents(db, candidate);
  signal.throwIfAborted();
  // Every generation is rebuilt from canonical Postgres rows. Existing R2
  // objects are never read or transformed in place.
  const compressed = gzipSync(Buffer.concat(archive.lines));
  const objectKey = chatEventSnapshotObjectKey(
    candidate.chatThreadId,
    archive.lastSeqId,
    sha256Hex(compressed),
  );
  await get(
    putImmutableS3Object(bucket, objectKey, compressed, ARCHIVE_CONTENT_TYPE, {
      signal,
      contentEncoding: ARCHIVE_CONTENT_ENCODING,
    }),
  );
  signal.throwIfAborted();

  // A deleted thread (foreign key) or a concurrent writer that already
  // published this thread's next head (unique head/object key) are expected
  // races: skip the thread and leave the uploaded object orphaned.
  const published = await settle(
    publishSnapshotHead(db, candidate, archive.lastSeqId, objectKey),
  );
  if (!published.ok) {
    if (
      !isForeignKeyViolation(published.error) &&
      !isUniqueViolation(published.error)
    ) {
      throw published.error;
    }
    return null;
  }
  return published.value ? archive.count : null;
}

async function chatEventSnapshotConvergence(
  db: Db,
): Promise<ChatEventSnapshotConvergence> {
  const versions = await db
    .select({
      archiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
      heads: count(),
    })
    .from(chatEventSnapshots)
    .where(eq(chatEventSnapshots.isHead, true))
    .groupBy(chatEventSnapshots.archiveSchemaVersion)
    .orderBy(asc(chatEventSnapshots.archiveSchemaVersion));
  const snapshotHeads = versions.reduce((total, version) => {
    return total + version.heads;
  }, 0);
  const nonV4SnapshotHeads = versions.reduce((total, version) => {
    return version.archiveSchemaVersion === ARCHIVE_SCHEMA_VERSION
      ? total
      : total + version.heads;
  }, 0);
  return {
    snapshotHeads,
    nonV4SnapshotHeads,
    snapshotHeadVersions: versions,
  };
}

interface R2GcStats {
  readonly scanned: number;
  readonly measured: number;
  readonly deleted: number;
  readonly bytesMeasured: number;
  readonly bytesDeleted: number;
  readonly shardsScanned: number;
  readonly subpartitionedShards: number;
}

interface RetiredSnapshotVersionGcStats {
  readonly selected: number;
  readonly referencesDeleted: number;
}

async function deleteRetiredSnapshotVersions(
  get: ComputedGetter,
  db: Db,
  bucket: string,
  deleteQuota: number,
  signal: AbortSignal,
): Promise<RetiredSnapshotVersionGcStats> {
  const candidates = await db
    .select({
      id: chatEventSnapshots.id,
      objectKey: chatEventSnapshots.objectKey,
    })
    .from(chatEventSnapshots)
    .where(
      lt(
        chatEventSnapshots.archiveSchemaVersion,
        MIN_SUPPORTED_ARCHIVE_SCHEMA_VERSION,
      ),
    )
    .limit(deleteQuota);
  signal.throwIfAborted();
  if (candidates.length === 0) {
    return { selected: 0, referencesDeleted: 0 };
  }

  const candidateIds = candidates.map((candidate) => {
    return candidate.id;
  });
  const objectKeys = candidates.map((candidate) => {
    return candidate.objectKey;
  });
  const referenceDeletion = db
    .delete(chatEventSnapshots)
    .where(
      and(
        inArray(chatEventSnapshots.id, candidateIds),
        lt(
          chatEventSnapshots.archiveSchemaVersion,
          MIN_SUPPORTED_ARCHIVE_SCHEMA_VERSION,
        ),
      ),
    )
    .returning({ id: chatEventSnapshots.id });
  // R2 cleanup is deliberately best-effort. Running it beside the database
  // delete keeps either system's failure from preventing the other attempt;
  // failed object deletes become ordinary unreferenced-object GC candidates.
  const objectDeletion = settle(get(deleteS3Objects(bucket, objectKeys)));
  const [deletedReferences] = await Promise.all([
    referenceDeletion,
    objectDeletion,
  ]);
  signal.throwIfAborted();
  return {
    selected: candidates.length,
    referencesDeleted: deletedReferences.length,
  };
}

function chatEventSnapshotGcPrefixes(now: Date): readonly string[] {
  const override = optionalEnv("CHAT_EVENT_SNAPSHOT_GC_SHARD");
  if (override !== undefined) {
    if (!/^[0-9a-f]{3}$/u.test(override)) {
      throw new Error(
        "CHAT_EVENT_SNAPSHOT_GC_SHARD must be three lowercase hex digits",
      );
    }
    return [`chat-events/${override}`];
  }
  const slot = Math.floor(now.getTime() / R2_GC_SLOT_MS);
  const first = (slot * R2_GC_SHARDS_PER_RUN) % R2_GC_SHARD_COUNT;
  return Array.from({ length: R2_GC_SHARDS_PER_RUN }, (_, offset) => {
    const shard = (first + offset) % R2_GC_SHARD_COUNT;
    return `chat-events/${shard.toString(16).padStart(3, "0")}`;
  });
}

async function boundedGcObjectPages(
  get: ComputedGetter,
  bucket: string,
  prefix: string,
): Promise<readonly (readonly S3Object[])[]> {
  const page = await get(listS3ObjectsPage(bucket, prefix, R2_GC_PAGE_SIZE));
  if (!page.isTruncated) {
    return [page.objects];
  }
  const pages: (readonly S3Object[])[] = [];
  for (const suffix of HEX_DIGITS) {
    const child = await get(
      listS3ObjectsPage(bucket, `${prefix}${suffix}`, R2_GC_PAGE_SIZE),
    );
    if (child.isTruncated) {
      throw new Error(
        `chat event snapshot GC partition ${prefix}${suffix} exceeds ${R2_GC_PAGE_SIZE.toString()} objects`,
      );
    }
    pages.push(child.objects);
  }
  return pages;
}

async function collectR2SnapshotGarbage(
  get: ComputedGetter,
  db: Db,
  bucket: string,
  deleteQuota: number,
  signal: AbortSignal,
): Promise<R2GcStats> {
  const now = nowDate();
  const olderThan = hoursBefore(
    now,
    positiveIntegerEnv(
      "CHAT_EVENT_SNAPSHOT_GC_GRACE_HOURS",
      DEFAULT_R2_GC_GRACE_HOURS,
    ),
  );
  const dryRun = booleanEnv("CHAT_EVENT_SNAPSHOT_GC_DRY_RUN", true);
  let scanned = 0;
  let measured = 0;
  let deleted = 0;
  let bytesMeasured = 0;
  let bytesDeleted = 0;
  let shardsScanned = 0;
  let subpartitionedShards = 0;
  let remainingDeleteQuota = deleteQuota;

  if (remainingDeleteQuota === 0) {
    return {
      scanned,
      measured,
      deleted,
      bytesMeasured,
      bytesDeleted,
      shardsScanned,
      subpartitionedShards,
    };
  }

  gcPrefixes: for (const prefix of chatEventSnapshotGcPrefixes(now)) {
    const pages = await boundedGcObjectPages(get, bucket, prefix);
    signal.throwIfAborted();
    shardsScanned += 1;
    if (pages.length > 1) {
      subpartitionedShards += 1;
    }
    for (const objects of pages) {
      scanned += objects.length;
      const oldObjects = objects.filter((object) => {
        return object.lastModified < olderThan;
      });
      if (oldObjects.length === 0) {
        continue;
      }
      const keys = oldObjects.map((object) => {
        return object.key;
      });
      const references = await db
        .select({
          objectKey: chatEventSnapshots.objectKey,
          isHead: chatEventSnapshots.isHead,
          createdAt: chatEventSnapshots.createdAt,
        })
        .from(chatEventSnapshots)
        .where(inArray(chatEventSnapshots.objectKey, keys));
      signal.throwIfAborted();
      const referencesByKey = new Map(
        references.map((reference) => {
          return [reference.objectKey, reference] as const;
        }),
      );
      const garbage = oldObjects.filter((object) => {
        const reference = referencesByKey.get(object.key);
        return (
          reference === undefined ||
          (!reference.isHead && reference.createdAt < olderThan)
        );
      });
      measured += garbage.length;
      bytesMeasured += garbage.reduce((total, object) => {
        return total + object.size;
      }, 0);
      if (dryRun || garbage.length === 0) {
        continue;
      }

      const deletionBatch = garbage.slice(0, remainingDeleteQuota);
      const garbageKeys = deletionBatch.map((object) => {
        return object.key;
      });
      const referenceDeletion = db
        .delete(chatEventSnapshots)
        .where(
          and(
            inArray(chatEventSnapshots.objectKey, garbageKeys),
            eq(chatEventSnapshots.isHead, false),
            lt(chatEventSnapshots.createdAt, olderThan),
          ),
        );
      const objectDeletion = settle(get(deleteS3Objects(bucket, garbageKeys)));
      const [, objectDeletionResult] = await Promise.all([
        referenceDeletion,
        objectDeletion,
      ]);
      signal.throwIfAborted();
      remainingDeleteQuota -= deletionBatch.length;
      if (objectDeletionResult.ok) {
        deleted += deletionBatch.length;
        bytesDeleted += deletionBatch.reduce((total, object) => {
          return total + object.size;
        }, 0);
      }
      if (remainingDeleteQuota === 0) {
        break gcPrefixes;
      }
    }
  }
  return {
    scanned,
    measured,
    deleted,
    bytesMeasured,
    bytesDeleted,
    shardsScanned,
    subpartitionedShards,
  };
}

/**
 * Archives chat_events into immutable canonical full-thread R2 snapshots.
 * Each bounded pass picks both retired-version heads and threads whose search
 * watermark advanced. It rebuilds from Postgres through that watermark,
 * uploads content-addressed v4 bytes, and publishes with an exact parent CAS.
 * Existing objects remain immutable. Repeated or interrupted ticks are
 * idempotent; a lost race can only leave a collectable orphan object.
 */
export const snapshotChatEvents$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ChatEventSnapshotStats> => {
    const db = set(writeDb$);
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const candidates = await db
      .select({
        chatThreadId: chatThreads.id,
        indexedSeqId: chatEventSearchWatermarks.indexedSeqId,
        headId: chatEventSnapshots.id,
        headLastSeqId: chatEventSnapshots.lastSeqId,
        headObjectKey: chatEventSnapshots.objectKey,
        headArchiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
      })
      .from(chatThreads)
      .innerJoin(
        chatEventSearchWatermarks,
        eq(chatEventSearchWatermarks.chatThreadId, chatThreads.id),
      )
      .leftJoin(
        chatEventSnapshots,
        and(
          eq(chatEventSnapshots.chatThreadId, chatThreads.id),
          eq(chatEventSnapshots.isHead, true),
        ),
      )
      // Retired heads are rebuilt even when idle; current v4 heads are picked
      // only when the indexed tail advanced. Future versions fail closed and
      // are reported by the convergence check instead of being overwritten.
      .where(
        and(
          or(
            isNull(chatEventSnapshots.archiveSchemaVersion),
            lte(
              chatEventSnapshots.archiveSchemaVersion,
              ARCHIVE_SCHEMA_VERSION,
            ),
          ),
          or(
            lt(chatEventSnapshots.archiveSchemaVersion, ARCHIVE_SCHEMA_VERSION),
            gt(
              chatEventSearchWatermarks.indexedSeqId,
              sql`COALESCE(${chatEventSnapshots.lastSeqId}, 0)`,
            ),
          ),
        ),
      )
      .orderBy(
        asc(chatEventSnapshots.archiveSchemaVersion),
        asc(chatThreads.lastMessageAt),
        asc(chatThreads.id),
      )
      .limit(chatEventSnapshotThreadBatchSize());
    signal.throwIfAborted();

    let snapshots = 0;
    let archivedEvents = 0;
    for (const candidate of candidates) {
      const archived = await archiveThread(get, db, bucket, candidate, signal);
      signal.throwIfAborted();
      if (archived !== null) {
        snapshots += 1;
        archivedEvents += archived;
      }
    }
    const retiredSnapshots = await deleteRetiredSnapshotVersions(
      get,
      db,
      bucket,
      SNAPSHOT_GC_DELETE_QUOTA,
      signal,
    );
    signal.throwIfAborted();
    const convergence = await chatEventSnapshotConvergence(db);
    signal.throwIfAborted();
    const r2Gc = await collectR2SnapshotGarbage(
      get,
      db,
      bucket,
      SNAPSHOT_GC_DELETE_QUOTA - retiredSnapshots.selected,
      signal,
    );
    signal.throwIfAborted();
    return {
      snapshots,
      archivedEvents,
      retiredSnapshotReferencesDeleted: retiredSnapshots.referencesDeleted,
      r2ObjectsScanned: r2Gc.scanned,
      r2ObjectsMeasured: r2Gc.measured,
      r2ObjectsDeleted: r2Gc.deleted,
      r2BytesMeasured: r2Gc.bytesMeasured,
      r2BytesDeleted: r2Gc.bytesDeleted,
      r2GcShardsScanned: r2Gc.shardsScanned,
      r2GcSubpartitionedShards: r2Gc.subpartitionedShards,
      ...convergence,
    };
  },
);

export const verifyChatEventSnapshotConvergence$ = command(
  async ({ set }, signal: AbortSignal) => {
    const convergence = await chatEventSnapshotConvergence(set(writeDb$));
    signal.throwIfAborted();
    return convergence;
  },
);
