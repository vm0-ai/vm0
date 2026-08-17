import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command, type Computed } from "ccstate";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSearchMessageWatermarks } from "@okouai/db/schema/chat-event-search";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  downloadS3Buffer,
  listS3ObjectsPage,
  putImmutableS3Object,
  type S3Object,
} from "../external/s3";
import { settle } from "../utils";
import {
  NO_DUPLICATE_EVENT_ID_NORMALIZATION,
  prepareChatEventArchiveWithNormalizedIds,
  type DuplicateEventIdNormalizationStats,
} from "./chat-event-snapshot-duplicate-id-normalization";
import { decodeChatEventSnapshotBody } from "./chat-event-snapshot-body.service";
import { upgradeChatEventSnapshotBody } from "./chat-event-snapshot-upgrade.service";

const log = logger("api:cron:snapshot-chat-events");

type ComputedGetter = <T>(computedValue: Computed<T>) => T;

interface ChatEventSnapshotStats {
  readonly snapshots: number;
  readonly archivedEvents: number;
  readonly unreadableParents: number;
  readonly skippedUnreadableHeads: number;
  readonly skippedUndecodableHeads: number;
  readonly skippedIncompleteHeads: number;
  readonly skippedUnsupportedHeads: number;
  readonly duplicateEventIdConflictThreads: number;
  readonly duplicateEventIdConflicts: number;
  readonly duplicateEventIdsRemapped: number;
  readonly duplicateEventReferencesRemapped: number;
  readonly retiredSnapshotReferencesDeleted: number;
  readonly r2ObjectsScanned: number;
  readonly r2ObjectsMeasured: number;
  readonly r2ObjectsDeleted: number;
  readonly r2BytesMeasured: number;
  readonly r2BytesDeleted: number;
  readonly r2GcShardsScanned: number;
  readonly r2GcSubpartitionedShards: number;
  readonly snapshotHeads: number;
  readonly nonCurrentSnapshotHeads: number;
  readonly snapshotHeadVersions: readonly ChatEventSnapshotHeadVersion[];
}

interface ChatEventSnapshotHeadVersion {
  readonly archiveSchemaVersion: number;
  readonly heads: number;
}

interface ChatEventSnapshotConvergence {
  readonly snapshotHeads: number;
  readonly nonCurrentSnapshotHeads: number;
  readonly snapshotHeadVersions: readonly ChatEventSnapshotHeadVersion[];
}

type ChatEventSnapshotScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "fixtures";
      readonly chatThreadIds: readonly string[];
      readonly r2ObjectKeys: readonly string[];
    };

interface SnapshotCandidate {
  readonly chatThreadId: string;
  readonly indexedSeqId: number;
  readonly headId: string | null;
  readonly headLastSeqId: number | null;
  readonly headLastEventId: string | null;
  readonly headObjectKey: string | null;
  readonly headArchiveSchemaVersion: number | null;
}

/**
 * Version of the Chat Event row contract stored in Snapshot NDJSON. Bump it
 * whenever the row schema changes; object encoding remains gzip NDJSON.
 */
const ARCHIVE_SCHEMA_VERSION = CURRENT_CHAT_EVENT_SCHEMA_VERSION;
const ARCHIVE_CONTENT_TYPE = "application/x-ndjson";
const ARCHIVE_CONTENT_ENCODING = "gzip";
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
/**
 * At the 10-minute cron cadence this cap permits 144k changed threads per day.
 * Normal traffic re-archives roughly 700 active threads per day, so the cap
 * leaves ample room for bursts while keeping each invocation bounded.
 */
const DEFAULT_THREAD_BATCH_SIZE = 1000;
const EVENT_PAGE_SIZE = 1000;
const R2_GC_GRACE_HOURS = 24 * 7;
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
const currentSnapshot = alias(
  chatEventSnapshots,
  "current_chat_event_snapshot",
);

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

function chatEventRowPayload(
  payload: ArchiveEventRow["payload"],
): ChatEventRow["payload"] {
  if (payload === null) {
    return null;
  }
  const { content, userMessage, thinking, error, usage } = payload;
  return {
    ...(content === undefined ? {} : { content }),
    ...(userMessage === undefined ? {} : { userMessage }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(error === undefined ? {} : { error }),
    ...(usage === undefined ? {} : { usage }),
  };
}

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

function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function encodeArchiveLine(line: ChatEventRow): Buffer {
  return Buffer.from(`${JSON.stringify(line)}\n`);
}

/**
 * One canonical archived chat event, one NDJSON line. Fields are listed
 * explicitly so a chat_events schema change cannot silently alter the durable
 * wire shape.
 */
export function chatEventRowFromDbRow(row: ArchiveEventRow): ChatEventRow {
  return chatEventRowSchema.parse({
    id: row.id,
    chatThreadId: row.chatThreadId,
    runId: row.runId,
    revokesEventId: row.revokesEventId,
    eventType: row.eventType,
    payload: chatEventRowPayload(row.payload),
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
  fromSeqId: number,
): Promise<{
  readonly lines: readonly Buffer[];
  readonly count: number;
  readonly lastEventId: string | null;
  readonly lastSeqId: number;
}> {
  const lines: Buffer[] = [];
  let cursor = fromSeqId;
  let count = 0;
  let lastEventId: string | null = null;
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
      lastEventId = row.id;
      lines.push(archiveLine(row));
    }
    count += rows.length;
    const lastRow = rows[rows.length - 1];
    if (lastRow !== undefined) {
      cursor = lastRow.seqId;
    }
    if (rows.length < EVENT_PAGE_SIZE) {
      return {
        lines,
        count,
        lastEventId,
        lastSeqId: candidate.indexedSeqId,
      };
    }
  }
}

interface SnapshotSource {
  readonly id: string;
  readonly lastSeqId: number;
  readonly lastEventId: string;
  readonly objectKey: string;
  readonly schemaVersion: number;
}

type SnapshotSkipReason =
  | "unreadable"
  | "undecodable"
  | "incomplete"
  | "unsupported";

type SnapshotSourceResolution =
  | { readonly kind: "initial" }
  | { readonly kind: "reusable"; readonly source: SnapshotSource }
  | { readonly kind: "skipped"; readonly reason: SnapshotSkipReason };

interface SnapshotSourceMetadata {
  readonly id: string;
  readonly lastSeqId: number | null;
  readonly lastEventId: string | null;
  readonly objectKey: string | null;
  readonly schemaVersion: number | null;
}

function resolveSnapshotSource(
  source: SnapshotSourceMetadata | undefined,
): SnapshotSourceResolution {
  if (source === undefined) {
    return { kind: "initial" };
  }
  if (
    source.lastSeqId === null ||
    source.lastSeqId <= 0 ||
    source.lastEventId === null ||
    source.objectKey === null ||
    source.objectKey.trim().length === 0 ||
    source.schemaVersion === null
  ) {
    return { kind: "skipped", reason: "incomplete" };
  }
  if (source.schemaVersion !== CURRENT_CHAT_EVENT_SCHEMA_VERSION) {
    return { kind: "skipped", reason: "unsupported" };
  }
  return {
    kind: "reusable",
    source: {
      id: source.id,
      lastSeqId: source.lastSeqId,
      lastEventId: source.lastEventId,
      objectKey: source.objectKey,
      schemaVersion: source.schemaVersion,
    },
  };
}

function candidateCurrentSource(
  candidate: SnapshotCandidate,
): SnapshotSource | null {
  const resolved = resolveSnapshotSource(
    candidate.headId === null
      ? undefined
      : {
          id: candidate.headId,
          lastSeqId: candidate.headLastSeqId,
          lastEventId: candidate.headLastEventId,
          objectKey: candidate.headObjectKey,
          schemaVersion: candidate.headArchiveSchemaVersion,
        },
  );
  if (resolved.kind === "initial") {
    return null;
  }
  if (resolved.kind === "skipped") {
    throw new Error("Chat Event Snapshot pointer is not reusable");
  }
  return resolved.source;
}

async function storedSnapshotSource(
  db: Db,
  candidate: SnapshotCandidate,
): Promise<SnapshotSourceResolution> {
  if (candidate.headId !== null) {
    return resolveSnapshotSource({
      id: candidate.headId,
      lastSeqId: candidate.headLastSeqId,
      lastEventId: candidate.headLastEventId,
      objectKey: candidate.headObjectKey,
      schemaVersion: candidate.headArchiveSchemaVersion,
    });
  }
  const sources = await db
    .select({
      id: chatEventSnapshots.id,
      lastSeqId: chatEventSnapshots.lastSeqId,
      lastEventId: chatEventSnapshots.lastEventId,
      objectKey: chatEventSnapshots.objectKey,
      schemaVersion: chatEventSnapshots.archiveSchemaVersion,
    })
    .from(chatEventSnapshots)
    .where(eq(chatEventSnapshots.chatThreadId, candidate.chatThreadId))
    .orderBy(
      desc(chatEventSnapshots.lastSeqId),
      desc(chatEventSnapshots.archiveSchemaVersion),
      desc(chatEventSnapshots.createdAt),
      desc(chatEventSnapshots.id),
    );
  const source = sources[0];
  return resolveSnapshotSource(source);
}

type SnapshotPrefixResolution =
  | { readonly kind: "reusable"; readonly body: Buffer }
  | {
      readonly kind: "skipped";
      readonly reason: "unreadable" | "undecodable";
    };

async function readSnapshotPrefix(
  get: ComputedGetter,
  bucket: string,
  chatThreadId: string,
  source: SnapshotSource,
  signal: AbortSignal,
): Promise<SnapshotPrefixResolution> {
  const downloaded = await settle(
    get(downloadS3Buffer(bucket, source.objectKey)),
    signal,
  );
  if (!downloaded.ok) {
    return { kind: "skipped", reason: "unreadable" };
  }
  const decoded = await settle(
    (async () => {
      const digest = /-([0-9a-f]{64})\.ndjson\.gz$/u.exec(
        source.objectKey,
      )?.[1];
      if (digest === undefined || sha256Hex(downloaded.value) !== digest) {
        throw new Error(
          "Chat Event Snapshot object checksum does not match its key",
        );
      }
      const decompressed = await gunzipAsync(downloaded.value);
      const upgraded = upgradeChatEventSnapshotBody(
        decompressed,
        source.schemaVersion,
        CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      );
      const rows = decodeChatEventSnapshotBody(upgraded);
      const last = rows.at(-1);
      if (
        last === undefined ||
        last.id !== source.lastEventId ||
        last.seqId > source.lastSeqId
      ) {
        throw new Error("Chat Event Snapshot body does not match its cursor");
      }
      for (const [index, row] of rows.entries()) {
        if (
          row.chatThreadId !== chatThreadId ||
          (index > 0 && row.seqId <= (rows[index - 1]?.seqId ?? 0))
        ) {
          throw new Error("Chat Event Snapshot body violates prefix ordering");
        }
      }
      return upgraded;
    })(),
    signal,
  );
  return decoded.ok
    ? { kind: "reusable", body: decoded.value }
    : { kind: "skipped", reason: "undecodable" };
}

function exactSnapshotPointer(source: SnapshotSource) {
  return and(
    eq(chatEventSnapshots.id, source.id),
    eq(chatEventSnapshots.lastSeqId, source.lastSeqId),
    eq(chatEventSnapshots.lastEventId, source.lastEventId),
    eq(chatEventSnapshots.objectKey, source.objectKey),
    eq(chatEventSnapshots.archiveSchemaVersion, source.schemaVersion),
  );
}

/** Publish one version pointer only if its exact source is still current. */
async function publishSnapshotVersion(
  db: Db,
  candidate: SnapshotCandidate,
  source: SnapshotSource | null,
  pointer: {
    readonly lastSeqId: number;
    readonly lastEventId: string;
    readonly objectKey: string;
  },
): Promise<boolean> {
  const { lastSeqId, lastEventId, objectKey } = pointer;
  return await db.transaction(async (tx) => {
    const current = candidateCurrentSource(candidate);
    if (current !== null) {
      const updated = await tx
        .update(chatEventSnapshots)
        .set({
          lastSeqId,
          lastEventId,
          objectKey,
          createdAt: nowDate(),
        })
        .where(exactSnapshotPointer(current))
        .returning({ id: chatEventSnapshots.id });
      if (updated.length === 0) {
        return false;
      }
      return true;
    }

    if (source !== null && source.objectKey === objectKey) {
      const upgraded = await tx
        .update(chatEventSnapshots)
        .set({
          archiveSchemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          lastSeqId,
          lastEventId,
          createdAt: nowDate(),
        })
        .where(exactSnapshotPointer(source))
        .returning({ id: chatEventSnapshots.id });
      if (upgraded.length === 0) {
        return false;
      }
      return true;
    }

    if (source !== null) {
      const deleted = await tx
        .delete(chatEventSnapshots)
        .where(exactSnapshotPointer(source))
        .returning({ id: chatEventSnapshots.id });
      if (deleted.length === 0) {
        return false;
      }
    }
    const [inserted] = await tx
      .insert(chatEventSnapshots)
      .values({
        chatThreadId: candidate.chatThreadId,
        lastSeqId,
        lastEventId,
        archiveSchemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        objectKey,
      })
      .returning({ id: chatEventSnapshots.id });
    if (inserted === undefined) {
      return false;
    }
    return true;
  });
}

interface ArchivedThread {
  readonly archivedEvents: number | null;
  readonly skippedHead: SnapshotSkipReason | null;
  readonly normalization: DuplicateEventIdNormalizationStats;
}

function skippedArchivedThread(
  candidate: SnapshotCandidate,
  reason: SnapshotSkipReason,
): ArchivedThread {
  log.warn("Skipped Chat Event Snapshot pointer", {
    type: "chat_event_snapshot_head_skipped",
    chatThreadId: candidate.chatThreadId,
    reason,
  });
  return {
    archivedEvents: null,
    skippedHead: reason,
    normalization: NO_DUPLICATE_EVENT_ID_NORMALIZATION,
  };
}

type ArchivePrefixResolution =
  | {
      readonly kind: "reusable";
      readonly source: SnapshotSource | null;
      readonly prefix: Buffer | null;
    }
  | { readonly kind: "skipped"; readonly reason: SnapshotSkipReason };

async function resolveArchivePrefix(
  get: ComputedGetter,
  db: Db,
  bucket: string,
  candidate: SnapshotCandidate,
  signal: AbortSignal,
): Promise<ArchivePrefixResolution> {
  const sourceResolution = await storedSnapshotSource(db, candidate);
  signal.throwIfAborted();
  if (sourceResolution.kind === "skipped") {
    return sourceResolution;
  }
  if (sourceResolution.kind === "initial") {
    return { kind: "reusable", source: null, prefix: null };
  }
  const prefixResolution = await readSnapshotPrefix(
    get,
    bucket,
    candidate.chatThreadId,
    sourceResolution.source,
    signal,
  );
  if (prefixResolution.kind === "skipped") {
    return prefixResolution;
  }
  return {
    kind: "reusable",
    source: sourceResolution.source,
    prefix: prefixResolution.body,
  };
}

function terminalSnapshotEventId(
  archiveLastEventId: string | null,
  source: SnapshotSource | null,
): string {
  const lastEventId = archiveLastEventId ?? source?.lastEventId;
  if (lastEventId === undefined) {
    throw new Error("Chat Event Snapshot has no terminal event ID");
  }
  return lastEventId;
}

async function archiveThread(
  get: ComputedGetter,
  db: Db,
  bucket: string,
  candidate: SnapshotCandidate,
  signal: AbortSignal,
): Promise<ArchivedThread> {
  const resolved = await resolveArchivePrefix(
    get,
    db,
    bucket,
    candidate,
    signal,
  );
  if (resolved.kind === "skipped") {
    return skippedArchivedThread(candidate, resolved.reason);
  }
  const { source, prefix } = resolved;
  const targetSeqId = Math.max(candidate.indexedSeqId, source?.lastSeqId ?? 0);
  const archive = await readCanonicalEvents(
    db,
    { ...candidate, indexedSeqId: targetSeqId },
    source?.lastSeqId ?? 0,
  );
  signal.throwIfAborted();
  if (
    archive.count === 0 &&
    source?.schemaVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION
  ) {
    return {
      archivedEvents: null,
      skippedHead: null,
      normalization: NO_DUPLICATE_EVENT_ID_NORMALIZATION,
    };
  }
  if (archive.count === 0 && source === null) {
    throw new Error(
      `chat event snapshot rebuild for ${candidate.chatThreadId} contained no events through indexed seq ${candidate.indexedSeqId.toString()}`,
    );
  }
  const lastEventId = terminalSnapshotEventId(archive.lastEventId, source);
  const prepared =
    prefix === null
      ? {
          body: Buffer.concat(archive.lines),
          normalization: NO_DUPLICATE_EVENT_ID_NORMALIZATION,
        }
      : prepareChatEventArchiveWithNormalizedIds(
          candidate.chatThreadId,
          prefix,
          archive.lines,
        );
  if (prepared.normalization.conflictingEventIds > 0) {
    log.warn("Normalized duplicate chat event IDs in snapshot", {
      type: "chat_event_snapshot_duplicate_ids_normalized",
      chatThreadId: candidate.chatThreadId,
      conflictingEventIdCount: prepared.normalization.conflictingEventIds,
      remappedEventIdCount: prepared.normalization.remappedEventIds,
      remappedReferenceCount: prepared.normalization.remappedEventReferences,
    });
  }
  const compressed = await gzipAsync(prepared.body);
  const objectKey = chatEventSnapshotObjectKey(
    candidate.chatThreadId,
    targetSeqId,
    sha256Hex(compressed),
  );
  await get(
    putImmutableS3Object(bucket, objectKey, compressed, ARCHIVE_CONTENT_TYPE, {
      signal,
      contentEncoding: ARCHIVE_CONTENT_ENCODING,
    }),
  );
  signal.throwIfAborted();

  const published = await settle(
    publishSnapshotVersion(db, candidate, source, {
      lastSeqId: targetSeqId,
      lastEventId,
      objectKey,
    }),
  );
  if (!published.ok) {
    if (
      !isForeignKeyViolation(published.error) &&
      !isUniqueViolation(published.error)
    ) {
      throw published.error;
    }
    return {
      archivedEvents: null,
      skippedHead: null,
      normalization: prepared.normalization,
    };
  }
  return {
    archivedEvents: published.value ? archive.count : null,
    skippedHead: null,
    normalization: prepared.normalization,
  };
}

/**
 * Persist the current-version pointer on demand from an existing Snapshot plus
 * its latest Raw Event tail. A thread with no Snapshot remains a normal cold
 * start and is left for the bounded cron.
 */
export const migrateCurrentChatEventSnapshot$ = command(
  async (
    { get, set },
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [thread] = await db
      .select({ indexedSeqId: chatThreads.lastChatEventSeqId })
      .from(chatThreads)
      .where(eq(chatThreads.id, chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (thread === undefined) {
      return false;
    }
    const [head] = await db
      .select({
        headId: chatEventSnapshots.id,
        headLastSeqId: chatEventSnapshots.lastSeqId,
        headLastEventId: chatEventSnapshots.lastEventId,
        headObjectKey: chatEventSnapshots.objectKey,
        headArchiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
      })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, chatThreadId),
          eq(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (head !== undefined) {
      return true;
    }
    const [stored] = await db
      .select({ id: chatEventSnapshots.id })
      .from(chatEventSnapshots)
      .where(eq(chatEventSnapshots.chatThreadId, chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (stored === undefined) {
      return false;
    }
    const archived = await archiveThread(
      get,
      db,
      env("R2_USER_STORAGES_BUCKET_NAME"),
      {
        chatThreadId,
        indexedSeqId: thread.indexedSeqId,
        headId: null,
        headLastSeqId: null,
        headLastEventId: null,
        headObjectKey: null,
        headArchiveSchemaVersion: null,
      },
      signal,
    );
    signal.throwIfAborted();
    return archived.skippedHead === null;
  },
);

async function chatEventSnapshotConvergence(
  db: Db,
  chatThreadIds: readonly string[] | null,
): Promise<ChatEventSnapshotConvergence> {
  const versions = await db
    .select({
      archiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
      heads: count(),
    })
    .from(chatEventSnapshots)
    .where(
      chatThreadIds === null
        ? undefined
        : inArray(chatEventSnapshots.chatThreadId, chatThreadIds),
    )
    .groupBy(chatEventSnapshots.archiveSchemaVersion)
    .orderBy(asc(chatEventSnapshots.archiveSchemaVersion));
  const snapshotHeads = versions.reduce((total, version) => {
    return total + version.heads;
  }, 0);
  const nonCurrentSnapshotHeads = versions.reduce((total, version) => {
    return version.archiveSchemaVersion === ARCHIVE_SCHEMA_VERSION
      ? total
      : total + version.heads;
  }, 0);
  return {
    snapshotHeads,
    nonCurrentSnapshotHeads,
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

interface R2GcOptions {
  readonly deleteQuota: number;
  readonly ownedObjectKeys: ReadonlySet<string> | null;
}

interface RetiredSnapshotVersionGcStats {
  readonly selected: number;
  readonly referencesDeleted: number;
}

interface RetiredSnapshotVersionGcOptions {
  readonly deleteQuota: number;
  readonly chatThreadIds: readonly string[] | null;
}

const deleteRetiredSnapshotVersions$ = command(
  async (
    _,
    db: Db,
    options: RetiredSnapshotVersionGcOptions,
    signal: AbortSignal,
  ): Promise<RetiredSnapshotVersionGcStats> => {
    const candidates = await db
      .select({
        id: chatEventSnapshots.id,
      })
      .from(chatEventSnapshots)
      .where(
        and(
          lt(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
          // Never discard the only durable historical prefix. Once a current
          // pointer exists, older stored pointers are superseded.
          exists(
            db
              .select({ id: currentSnapshot.id })
              .from(currentSnapshot)
              .where(
                and(
                  eq(
                    currentSnapshot.chatThreadId,
                    chatEventSnapshots.chatThreadId,
                  ),
                  eq(
                    currentSnapshot.archiveSchemaVersion,
                    CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                  ),
                ),
              ),
          ),
          options.chatThreadIds === null
            ? undefined
            : inArray(chatEventSnapshots.chatThreadId, options.chatThreadIds),
        ),
      )
      .limit(options.deleteQuota);
    signal.throwIfAborted();
    if (candidates.length === 0) {
      return { selected: 0, referencesDeleted: 0 };
    }

    const candidateIds = candidates.map((candidate) => {
      return candidate.id;
    });
    const deletedReferences = await db
      .delete(chatEventSnapshots)
      .where(
        and(
          inArray(chatEventSnapshots.id, candidateIds),
          lt(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
          exists(
            db
              .select({ id: currentSnapshot.id })
              .from(currentSnapshot)
              .where(
                and(
                  eq(
                    currentSnapshot.chatThreadId,
                    chatEventSnapshots.chatThreadId,
                  ),
                  eq(
                    currentSnapshot.archiveSchemaVersion,
                    CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                  ),
                ),
              ),
          ),
        ),
      )
      .returning({ id: chatEventSnapshots.id });
    signal.throwIfAborted();
    // Object deletion belongs to the reference-aware R2 GC below. A historical
    // and current version may share one content-addressed key, so deleting the
    // key alongside just one pointer would be unsafe.
    return {
      selected: candidates.length,
      referencesDeleted: deletedReferences.length,
    };
  },
);

function chatEventSnapshotGcPrefixes(now: Date): readonly string[] {
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
  options: R2GcOptions,
  signal: AbortSignal,
): Promise<R2GcStats> {
  const now = nowDate();
  const olderThan = hoursBefore(now, R2_GC_GRACE_HOURS);
  let scanned = 0;
  let measured = 0;
  let deleted = 0;
  let bytesMeasured = 0;
  let bytesDeleted = 0;
  let shardsScanned = 0;
  let subpartitionedShards = 0;
  let remainingDeleteQuota = options.deleteQuota;
  const ownedObjectKeys = options.ownedObjectKeys;

  if (remainingDeleteQuota === 0 || ownedObjectKeys?.size === 0) {
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
      const scopedObjects =
        ownedObjectKeys === null
          ? objects
          : objects.filter((object) => {
              return ownedObjectKeys.has(object.key);
            });
      scanned += scopedObjects.length;
      const oldObjects = scopedObjects.filter((object) => {
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
        return referencesByKey.get(object.key) === undefined;
      });
      measured += garbage.length;
      bytesMeasured += garbage.reduce((total, object) => {
        return total + object.size;
      }, 0);
      if (garbage.length === 0) {
        continue;
      }

      const deletionBatch = garbage.slice(0, remainingDeleteQuota);
      const garbageKeys = deletionBatch.map((object) => {
        return object.key;
      });
      const objectDeletion = settle(get(deleteS3Objects(bucket, garbageKeys)));
      const objectDeletionResult = await objectDeletion;
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

async function loadSnapshotCandidates(
  db: Db,
  chatThreadIds: readonly string[] | null,
): Promise<readonly SnapshotCandidate[]> {
  return await db
    .select({
      chatThreadId: chatThreads.id,
      indexedSeqId: chatEventSearchMessageWatermarks.indexedSeqId,
      headId: chatEventSnapshots.id,
      headLastSeqId: chatEventSnapshots.lastSeqId,
      headLastEventId: chatEventSnapshots.lastEventId,
      headObjectKey: chatEventSnapshots.objectKey,
      headArchiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
    })
    .from(chatThreads)
    .innerJoin(
      chatEventSearchMessageWatermarks,
      eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
    )
    .leftJoin(
      chatEventSnapshots,
      and(
        eq(chatEventSnapshots.chatThreadId, chatThreads.id),
        eq(
          chatEventSnapshots.archiveSchemaVersion,
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        ),
      ),
    )
    .where(
      and(
        chatThreadIds === null
          ? undefined
          : inArray(chatThreads.id, chatThreadIds),
        or(
          gt(
            chatEventSearchMessageWatermarks.indexedSeqId,
            sql`COALESCE(${chatEventSnapshots.lastSeqId}, 0)`,
          ),
          and(
            isNotNull(chatEventSnapshots.id),
            or(
              lte(chatEventSnapshots.lastSeqId, 0),
              sql`btrim(${chatEventSnapshots.objectKey}) = ''`,
            ),
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
}

/**
 * Archives Chat Events into immutable, content-addressed R2 Snapshots. The
 * first Snapshot may bootstrap from the currently available Raw Event prefix,
 * whose sequence positions may start above 1 and contain gaps. Every later
 * refresh or schema upgrade must reuse a stored Snapshot prefix and append only
 * the Raw Event tail after its paired cursor. Missing objects and missing
 * migrations fail closed because older Raw Events may be reclaimed. Publication
 * uses an exact pointer CAS, so a lost race can only leave a collectable orphan
 * object.
 */
export const snapshotChatEvents$ = command(
  async (
    { get, set },
    scope: ChatEventSnapshotScope,
    signal: AbortSignal,
  ): Promise<ChatEventSnapshotStats> => {
    const db = set(writeDb$);
    const chatThreadIds = scope.kind === "global" ? null : scope.chatThreadIds;
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const ownedObjectKeys =
      scope.kind === "global" ? null : new Set(scope.r2ObjectKeys);
    const candidates = await loadSnapshotCandidates(db, chatThreadIds);
    signal.throwIfAborted();

    let snapshots = 0;
    let archivedEvents = 0;
    let unreadableParents = 0;
    let skippedUnreadableHeads = 0;
    let skippedUndecodableHeads = 0;
    let skippedIncompleteHeads = 0;
    let skippedUnsupportedHeads = 0;
    let duplicateEventIdConflictThreads = 0;
    let duplicateEventIdConflicts = 0;
    let duplicateEventIdsRemapped = 0;
    let duplicateEventReferencesRemapped = 0;
    for (const candidate of candidates) {
      const archived = await archiveThread(get, db, bucket, candidate, signal);
      signal.throwIfAborted();
      switch (archived.skippedHead) {
        case "unreadable": {
          skippedUnreadableHeads += 1;
          unreadableParents += 1;
          break;
        }
        case "undecodable": {
          skippedUndecodableHeads += 1;
          unreadableParents += 1;
          break;
        }
        case "incomplete": {
          skippedIncompleteHeads += 1;
          break;
        }
        case "unsupported": {
          skippedUnsupportedHeads += 1;
          break;
        }
        case null: {
          break;
        }
      }
      if (archived.archivedEvents !== null) {
        snapshots += 1;
        archivedEvents += archived.archivedEvents;
      }
      if (archived.normalization.conflictingEventIds > 0) {
        duplicateEventIdConflictThreads += 1;
      }
      duplicateEventIdConflicts += archived.normalization.conflictingEventIds;
      duplicateEventIdsRemapped += archived.normalization.remappedEventIds;
      duplicateEventReferencesRemapped +=
        archived.normalization.remappedEventReferences;
    }
    const retiredSnapshots = await set(
      deleteRetiredSnapshotVersions$,
      db,
      {
        deleteQuota: SNAPSHOT_GC_DELETE_QUOTA,
        chatThreadIds,
      },
      signal,
    );
    signal.throwIfAborted();
    const convergence = await chatEventSnapshotConvergence(db, chatThreadIds);
    signal.throwIfAborted();
    const r2Gc = await collectR2SnapshotGarbage(
      get,
      db,
      bucket,
      {
        deleteQuota: SNAPSHOT_GC_DELETE_QUOTA - retiredSnapshots.selected,
        ownedObjectKeys,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      snapshots,
      archivedEvents,
      unreadableParents,
      skippedUnreadableHeads,
      skippedUndecodableHeads,
      skippedIncompleteHeads,
      skippedUnsupportedHeads,
      duplicateEventIdConflictThreads,
      duplicateEventIdConflicts,
      duplicateEventIdsRemapped,
      duplicateEventReferencesRemapped,
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
