import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  CHAT_EVENT_CONTENT_TEXT_TYPES,
  CHAT_EVENT_USER_MESSAGE_TEXT_TYPES,
} from "@vm0/api-contracts/contracts/chat-events";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@vm0/api-contracts/contracts/chat-event-rows";
import { command, type Computed } from "ccstate";
import {
  and,
  asc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
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
  downloadS3Buffer,
  ensureS3CorsGetOrigin,
  listS3ObjectsPage,
  putImmutableS3Object,
  type S3Object,
} from "../external/s3";
import { settle } from "../utils";

type ComputedGetter = <T>(computedValue: Computed<T>) => T;

interface ChatEventSnapshotStats {
  readonly corsChanged: boolean;
  readonly snapshots: number;
  readonly archivedEvents: number;
  readonly payloadRowsMeasured: number;
  readonly payloadRowsReclaimed: number;
  readonly payloadReclaimHasMore: boolean;
  readonly r2ObjectsScanned: number;
  readonly r2ObjectsMeasured: number;
  readonly r2ObjectsDeleted: number;
  readonly r2BytesMeasured: number;
  readonly r2BytesDeleted: number;
  readonly r2GcShardsScanned: number;
  readonly r2GcSubpartitionedShards: number;
}

export function chatEventSnapshotCorsReady() {
  const appOrigin = new URL(env("APP_URL")).origin;
  return ensureS3CorsGetOrigin(env("R2_USER_STORAGES_BUCKET_NAME"), appOrigin);
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
 * shape (chatEventRowSchema) or the object encoding changes. v3 stores objects
 * with `Content-Encoding: gzip` metadata so browsers decompress snapshot
 * downloads transparently; readers only serve v3 heads.
 */
export const ARCHIVE_SCHEMA_VERSION = 3;
const ARCHIVE_CONTENT_TYPE = "application/x-ndjson";
const ARCHIVE_CONTENT_ENCODING = "gzip";
/**
 * At the 10-minute cron cadence this cap permits 72k changed threads per day.
 * Normal traffic re-archives roughly 700 active threads per day, so the cap
 * leaves ample room for bursts while keeping each invocation bounded.
 */
const DEFAULT_THREAD_BATCH_SIZE = 500;
const EVENT_PAGE_SIZE = 1000;
const OBJECT_KEY_CONTENT_SHA256 = /-([0-9a-f]{64})\.ndjson\.gz$/;
const DEFAULT_PAYLOAD_RECLAIM_THREAD_BATCH_SIZE = 10;
const DEFAULT_PAYLOAD_RECLAIM_ROW_BATCH_SIZE = 500;
const DEFAULT_PAYLOAD_RECLAIM_GRACE_HOURS = 24 * 7;
const DEFAULT_R2_GC_GRACE_HOURS = 24 * 7;
const R2_GC_SHARDS_PER_RUN = 16;
const R2_GC_SHARD_COUNT = 16 ** 3;
const R2_GC_PAGE_SIZE = 1000;
/**
 * Matches the cron cadence so every invocation advances to the next shard
 * window; the 4096 shards are swept in about 1.8 days.
 */
const R2_GC_SLOT_MS = 10 * 60 * 1000;
const HEX_DIGITS = "0123456789abcdef";

const PRESERVED_USER_MESSAGE_EVENT_TYPES = [
  ...CHAT_EVENT_USER_MESSAGE_TEXT_TYPES,
  "input.budget",
] as const;

type ArchiveEventRow = Pick<
  typeof chatEvents.$inferSelect,
  | "id"
  | "chatThreadId"
  | "runId"
  | "usagePayload"
  | "revokesEventId"
  | "interruptsRunId"
  | "runGroupId"
  | "eventType"
  | "contextType"
  | "contextId"
  | "content"
  | "userMessage"
  | "thinking"
  | "error"
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

function encodeArchiveLine(line: ChatEventRow): Buffer {
  return Buffer.from(`${JSON.stringify(line)}\n`);
}

/**
 * One archived chat event, one NDJSON line. Fields are listed explicitly so
 * that a chat_events schema change forces a conscious decision here instead
 * of silently changing the persisted archive shape.
 */
export function chatEventRowFromDbRow(row: ArchiveEventRow): ChatEventRow {
  return {
    id: row.id,
    chatThreadId: row.chatThreadId,
    runId: row.runId,
    usagePayload: row.usagePayload,
    revokesEventId: row.revokesEventId,
    interruptsRunId: row.interruptsRunId,
    runGroupId: row.runGroupId,
    eventType: row.eventType,
    contextType: row.contextType,
    contextId: row.contextId,
    content: row.content,
    userMessage: row.userMessage,
    thinking: row.thinking,
    error: row.error,
    runEventSequenceNumber: row.runEventSequenceNumber,
    runEventId: row.runEventId,
    seqId: row.seqId,
    createdAt: row.createdAt.toISOString(),
  };
}

function archiveLine(row: ArchiveEventRow): Buffer {
  return encodeArchiveLine(chatEventRowFromDbRow(row));
}

function parseArchiveLines(raw: Buffer): readonly unknown[] {
  const text = raw.toString("utf8");
  if (text.length === 0 || !text.endsWith("\n")) {
    throw new Error(
      "chat event snapshot must be non-empty newline-delimited JSON",
    );
  }
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      return parsed;
    });
}

function validatedArchiveRows(raw: Buffer): readonly ChatEventRow[] {
  const lines = parseArchiveLines(raw);
  return lines.map((line) => {
    return chatEventRowSchema.parse(line);
  });
}

function validatedArchiveRaw(raw: Buffer): Buffer {
  validatedArchiveRows(raw);
  return raw;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function contentSha256FromObjectKey(objectKey: string): string {
  const hash = OBJECT_KEY_CONTENT_SHA256.exec(objectKey)?.[1];
  if (hash === undefined) {
    throw new Error(
      `chat event snapshot key is missing a content hash: ${objectKey}`,
    );
  }
  return hash;
}

function chatEventSnapshotObjectKey(
  chatThreadId: string,
  lastSeqId: number,
  contentSha256: string,
): string {
  return `chat-events/${chatThreadId}/${lastSeqId}-${contentSha256}.ndjson.gz`;
}

function verifiedArchiveRaw(objectKey: string, compressed: Buffer): Buffer {
  const expected = contentSha256FromObjectKey(objectKey);
  const actual = sha256Hex(compressed);
  if (actual !== expected) {
    throw new Error(
      `chat event snapshot object ${objectKey} content hash mismatch: ${actual}`,
    );
  }
  return gunzipSync(compressed);
}

function verifiedSnapshotRows(
  candidate: Pick<
    SnapshotCandidate,
    "chatThreadId" | "headLastSeqId" | "headObjectKey"
  >,
  compressed: Buffer,
): readonly ChatEventRow[] {
  if (candidate.headObjectKey === null || candidate.headLastSeqId === null) {
    throw new Error("chat event snapshot head metadata is incomplete");
  }
  const rows = validatedArchiveRows(
    verifiedArchiveRaw(candidate.headObjectKey, compressed),
  );
  let priorSeqId = 0;
  for (const row of rows) {
    if (row.chatThreadId !== candidate.chatThreadId) {
      throw new Error(
        `chat event snapshot ${candidate.headObjectKey} contains another thread`,
      );
    }
    if (row.seqId <= priorSeqId) {
      throw new Error(
        `chat event snapshot ${candidate.headObjectKey} is not strictly ordered`,
      );
    }
    priorSeqId = row.seqId;
  }
  if (priorSeqId !== candidate.headLastSeqId) {
    throw new Error(
      `chat event snapshot ${candidate.headObjectKey} does not reach its head watermark`,
    );
  }
  return rows;
}

async function readTailEvents(
  db: Db,
  candidate: SnapshotCandidate,
): Promise<{
  readonly lines: readonly Buffer[];
  readonly count: number;
  readonly lastSeqId: number;
}> {
  const lines: Buffer[] = [];
  let cursor = candidate.headLastSeqId ?? 0;
  let count = 0;
  for (;;) {
    const rows = await db
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        runId: chatEvents.runId,
        usagePayload: chatEvents.usagePayload,
        revokesEventId: chatEvents.revokesEventId,
        interruptsRunId: chatEvents.interruptsRunId,
        runGroupId: chatEvents.runGroupId,
        eventType: chatEvents.eventType,
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
        content: chatEvents.content,
        userMessage: chatEvents.userMessage,
        thinking: chatEvents.thinking,
        error: chatEvents.error,
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
      return { lines, count, lastSeqId: cursor };
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
      const demoted = await tx
        .update(chatEventSnapshots)
        .set({ isHead: false })
        .where(
          and(
            eq(chatEventSnapshots.id, candidate.headId),
            eq(chatEventSnapshots.isHead, true),
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
  const tail = await readTailEvents(db, candidate);
  signal.throwIfAborted();
  if (
    candidate.headId !== null &&
    candidate.headArchiveSchemaVersion !== ARCHIVE_SCHEMA_VERSION
  ) {
    throw new Error(
      `unsupported chat event snapshot schema version: ${candidate.headArchiveSchemaVersion}`,
    );
  }
  if (tail.count === 0) {
    return null;
  }

  // The parent object is the only source for the archived prefix: Postgres
  // payloads below the head watermark are reclaimed later, so rebuilds never
  // query that range. Re-reading the parent also re-verifies its hash.
  let parentRaw: Buffer = Buffer.alloc(0);
  if (candidate.headId !== null) {
    if (candidate.headObjectKey === null) {
      throw new Error("chat event snapshot head metadata is incomplete");
    }
    const parentCompressed = await get(
      downloadS3Buffer(bucket, candidate.headObjectKey),
    );
    signal.throwIfAborted();
    parentRaw = validatedArchiveRaw(
      verifiedArchiveRaw(candidate.headObjectKey, parentCompressed),
    );
  }

  const compressed = gzipSync(Buffer.concat([parentRaw, ...tail.lines]));
  const objectKey = chatEventSnapshotObjectKey(
    candidate.chatThreadId,
    tail.lastSeqId,
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
    publishSnapshotHead(db, candidate, tail.lastSeqId, objectKey),
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
  return published.value ? tail.count : null;
}

interface PayloadReclaimCandidate {
  readonly chatThreadId: string;
  readonly headId: string;
  readonly headLastSeqId: number;
  readonly headObjectKey: string;
}

interface PayloadReclaimStats {
  readonly measured: number;
  readonly reclaimed: number;
  readonly hasMore: boolean;
}

function reclaimablePayloadPresentCondition() {
  return or(
    isNotNull(chatEvents.usagePayload),
    isNotNull(chatEvents.thinking),
    isNotNull(chatEvents.error),
    and(
      not(inArray(chatEvents.eventType, [...CHAT_EVENT_CONTENT_TEXT_TYPES])),
      isNotNull(chatEvents.content),
    ),
    and(
      not(
        inArray(chatEvents.eventType, [...PRESERVED_USER_MESSAGE_EVENT_TYPES]),
      ),
      isNotNull(chatEvents.userMessage),
    ),
  );
}

function reclaimablePayloadCondition(
  db: Pick<Db, "select">,
  completedBefore: Date,
) {
  return and(
    isNotNull(chatEvents.runId),
    reclaimablePayloadPresentCondition(),
    exists(
      db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, chatEvents.runId),
            lt(agentRuns.completedAt, completedBefore),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: agentRunCallbacks.id })
        .from(agentRunCallbacks)
        .where(
          and(
            eq(agentRunCallbacks.runId, chatEvents.runId),
            eq(agentRunCallbacks.status, "pending"),
          ),
        ),
    ),
  );
}

function assertPayloadBackedBySnapshot(
  row: {
    readonly id: string;
    readonly eventType: string;
    readonly content: string | null;
    readonly userMessage: unknown;
    readonly thinking: string | null;
    readonly error: string | null;
    readonly usagePayload: unknown;
  },
  archived: ChatEventRow | undefined,
): void {
  if (archived === undefined) {
    throw new Error(`chat event snapshot is missing reclaim row ${row.id}`);
  }
  const comparisons: readonly [unknown, unknown, boolean][] = [
    [row.usagePayload, archived.usagePayload, row.usagePayload !== null],
    [row.thinking, archived.thinking, row.thinking !== null],
    [row.error, archived.error, row.error !== null],
    [
      row.content,
      archived.content,
      row.content !== null &&
        !CHAT_EVENT_CONTENT_TEXT_TYPES.some((eventType) => {
          return eventType === row.eventType;
        }),
    ],
    [
      row.userMessage,
      archived.userMessage,
      row.userMessage !== null &&
        !PRESERVED_USER_MESSAGE_EVENT_TYPES.some((eventType) => {
          return eventType === row.eventType;
        }),
    ],
  ];
  if (
    comparisons.some(([current, snapshot, shouldCompare]) => {
      return shouldCompare && !isDeepStrictEqual(current, snapshot);
    })
  ) {
    throw new Error(
      `chat event snapshot payload differs from reclaim row ${row.id}`,
    );
  }
}

async function findPayloadReclaimCandidates(
  db: Db,
  completedBefore: Date,
  threadBatchSize: number,
): Promise<PayloadReclaimCandidate[]> {
  return await db
    .select({
      chatThreadId: chatEventSnapshots.chatThreadId,
      headId: chatEventSnapshots.id,
      headLastSeqId: chatEventSnapshots.lastSeqId,
      headObjectKey: chatEventSnapshots.objectKey,
    })
    .from(chatEventSnapshots)
    .innerJoin(
      chatEventSearchWatermarks,
      eq(
        chatEventSearchWatermarks.chatThreadId,
        chatEventSnapshots.chatThreadId,
      ),
    )
    .where(
      and(
        eq(chatEventSnapshots.isHead, true),
        eq(chatEventSnapshots.archiveSchemaVersion, ARCHIVE_SCHEMA_VERSION),
        gte(
          chatEventSearchWatermarks.indexedSeqId,
          chatEventSnapshots.lastSeqId,
        ),
        exists(
          db
            .select({ id: chatEvents.id })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, chatEventSnapshots.chatThreadId),
                lte(chatEvents.seqId, chatEventSnapshots.lastSeqId),
                reclaimablePayloadCondition(db, completedBefore),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(chatEventSnapshots.createdAt), asc(chatEventSnapshots.id))
    .limit(threadBatchSize);
}

function archivedRowsById(
  candidate: PayloadReclaimCandidate,
  compressed: Buffer,
): ReadonlyMap<string, ChatEventRow> {
  return new Map(
    verifiedSnapshotRows(
      {
        chatThreadId: candidate.chatThreadId,
        headLastSeqId: candidate.headLastSeqId,
        headObjectKey: candidate.headObjectKey,
      },
      compressed,
    ).map((row): readonly [string, ChatEventRow] => {
      return [row.id, row];
    }),
  );
}

async function reclaimCandidatePayloads(
  db: Db,
  candidate: PayloadReclaimCandidate,
  archivedById: ReadonlyMap<string, ChatEventRow>,
  options: {
    readonly completedBefore: Date;
    readonly rowBatchSize: number;
    readonly dryRun: boolean;
  },
): Promise<PayloadReclaimStats> {
  return await db.transaction(async (tx) => {
    const [lockedHead] = await tx
      .select({
        id: chatEventSnapshots.id,
        lastSeqId: chatEventSnapshots.lastSeqId,
      })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.id, candidate.headId),
          eq(chatEventSnapshots.chatThreadId, candidate.chatThreadId),
          eq(chatEventSnapshots.objectKey, candidate.headObjectKey),
          eq(chatEventSnapshots.isHead, true),
          eq(chatEventSnapshots.archiveSchemaVersion, ARCHIVE_SCHEMA_VERSION),
        ),
      )
      .limit(1)
      .for("update");
    if (!lockedHead || lockedHead.lastSeqId !== candidate.headLastSeqId) {
      return { measured: 0, reclaimed: 0, hasMore: true };
    }
    const [watermark] = await tx
      .select({ indexedSeqId: chatEventSearchWatermarks.indexedSeqId })
      .from(chatEventSearchWatermarks)
      .where(
        and(
          eq(chatEventSearchWatermarks.chatThreadId, candidate.chatThreadId),
          gte(chatEventSearchWatermarks.indexedSeqId, candidate.headLastSeqId),
        ),
      )
      .limit(1);
    if (!watermark) {
      return { measured: 0, reclaimed: 0, hasMore: true };
    }

    const rows = await tx
      .select({
        id: chatEvents.id,
        eventType: chatEvents.eventType,
        content: chatEvents.content,
        userMessage: chatEvents.userMessage,
        thinking: chatEvents.thinking,
        error: chatEvents.error,
        usagePayload: chatEvents.usagePayload,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, candidate.chatThreadId),
          lte(chatEvents.seqId, candidate.headLastSeqId),
          reclaimablePayloadCondition(tx, options.completedBefore),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(options.rowBatchSize);
    for (const row of rows) {
      assertPayloadBackedBySnapshot(row, archivedById.get(row.id));
    }
    if (!options.dryRun && rows.length > 0) {
      await tx
        .update(chatEvents)
        .set({
          content: sql`CASE WHEN ${inArray(chatEvents.eventType, [...CHAT_EVENT_CONTENT_TEXT_TYPES])} THEN ${chatEvents.content} ELSE NULL END`,
          userMessage: sql`CASE WHEN ${inArray(chatEvents.eventType, [...PRESERVED_USER_MESSAGE_EVENT_TYPES])} THEN ${chatEvents.userMessage} ELSE NULL END`,
          thinking: null,
          error: null,
          usagePayload: null,
        })
        .where(
          and(
            inArray(
              chatEvents.id,
              rows.map((row) => {
                return row.id;
              }),
            ),
            reclaimablePayloadCondition(tx, options.completedBefore),
          ),
        );
    }
    return {
      measured: rows.length,
      reclaimed: options.dryRun ? 0 : rows.length,
      hasMore: rows.length === options.rowBatchSize,
    };
  });
}

async function reclaimSnapshotCoveredPayloads(
  get: ComputedGetter,
  db: Db,
  bucket: string,
  signal: AbortSignal,
): Promise<PayloadReclaimStats> {
  const now = nowDate();
  const completedBefore = hoursBefore(
    now,
    positiveIntegerEnv(
      "CHAT_EVENT_PAYLOAD_RECLAIM_GRACE_HOURS",
      DEFAULT_PAYLOAD_RECLAIM_GRACE_HOURS,
    ),
  );
  const threadBatchSize = positiveIntegerEnv(
    "CHAT_EVENT_PAYLOAD_RECLAIM_THREAD_BATCH_SIZE",
    DEFAULT_PAYLOAD_RECLAIM_THREAD_BATCH_SIZE,
  );
  const rowBatchSize = positiveIntegerEnv(
    "CHAT_EVENT_PAYLOAD_RECLAIM_ROW_BATCH_SIZE",
    DEFAULT_PAYLOAD_RECLAIM_ROW_BATCH_SIZE,
  );
  const dryRun = booleanEnv("CHAT_EVENT_PAYLOAD_RECLAIM_DRY_RUN", true);
  const candidates = await findPayloadReclaimCandidates(
    db,
    completedBefore,
    threadBatchSize,
  );
  signal.throwIfAborted();

  let measured = 0;
  let reclaimed = 0;
  let hasMore = candidates.length === threadBatchSize;
  for (const candidate of candidates) {
    const compressed = await get(
      downloadS3Buffer(bucket, candidate.headObjectKey),
    );
    signal.throwIfAborted();
    const result = await reclaimCandidatePayloads(
      db,
      candidate,
      archivedRowsById(candidate, compressed),
      { completedBefore, rowBatchSize, dryRun },
    );
    signal.throwIfAborted();
    measured += result.measured;
    reclaimed += result.reclaimed;
    hasMore ||= result.hasMore;
  }
  return { measured, reclaimed, hasMore };
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

export function chatEventSnapshotGcPrefixes(now: Date): readonly string[] {
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

  for (const prefix of chatEventSnapshotGcPrefixes(now)) {
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

      const garbageKeys = garbage.map((object) => {
        return object.key;
      });
      await db
        .delete(chatEventSnapshots)
        .where(
          and(
            inArray(chatEventSnapshots.objectKey, garbageKeys),
            eq(chatEventSnapshots.isHead, false),
            lt(chatEventSnapshots.createdAt, olderThan),
          ),
        );
      const stillReferenced = await db
        .select({ objectKey: chatEventSnapshots.objectKey })
        .from(chatEventSnapshots)
        .where(inArray(chatEventSnapshots.objectKey, garbageKeys));
      signal.throwIfAborted();
      const protectedKeys = new Set(
        stillReferenced.map((reference) => {
          return reference.objectKey;
        }),
      );
      const deletable = garbage.filter((object) => {
        return !protectedKeys.has(object.key);
      });
      await get(
        deleteS3Objects(
          bucket,
          deletable.map((object) => {
            return object.key;
          }),
        ),
      );
      signal.throwIfAborted();
      deleted += deletable.length;
      bytesDeleted += deletable.reduce((total, object) => {
        return total + object.size;
      }, 0);
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
 * Archives chat_events into immutable full-thread R2 snapshot objects, oldest
 * threads first. Each pass picks threads whose search watermark is ahead of
 * their head snapshot, rebuilds one full archive per thread (parent object +
 * Postgres tail up to the watermark), uploads it content-addressed, and
 * publishes it as the new head. The search watermark caps every snapshot so
 * archived events are always queryable before their Postgres payloads become
 * reclaimable. Ticks are idempotent: objects are immutable, the head swap is
 * guarded by the expected parent, and a lost race only leaves an orphaned
 * object behind.
 */
export const snapshotChatEvents$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ChatEventSnapshotStats> => {
    const db = set(writeDb$);
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const cors = await get(chatEventSnapshotCorsReady());
    signal.throwIfAborted();
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
      .where(
        or(
          gt(
            chatEventSearchWatermarks.indexedSeqId,
            sql`COALESCE(${chatEventSnapshots.lastSeqId}, 0)`,
          ),
          and(
            isNotNull(chatEventSnapshots.id),
            ne(chatEventSnapshots.archiveSchemaVersion, ARCHIVE_SCHEMA_VERSION),
          ),
        ),
      )
      .orderBy(asc(chatThreads.lastMessageAt), asc(chatThreads.id))
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
    const payload = await reclaimSnapshotCoveredPayloads(
      get,
      db,
      bucket,
      signal,
    );
    signal.throwIfAborted();
    const r2Gc = await collectR2SnapshotGarbage(get, db, bucket, signal);
    signal.throwIfAborted();
    return {
      corsChanged: cors.changed,
      snapshots,
      archivedEvents,
      payloadRowsMeasured: payload.measured,
      payloadRowsReclaimed: payload.reclaimed,
      payloadReclaimHasMore: payload.hasMore,
      r2ObjectsScanned: r2Gc.scanned,
      r2ObjectsMeasured: r2Gc.measured,
      r2ObjectsDeleted: r2Gc.deleted,
      r2BytesMeasured: r2Gc.bytesMeasured,
      r2BytesDeleted: r2Gc.bytesDeleted,
      r2GcShardsScanned: r2Gc.shardsScanned,
      r2GcSubpartitionedShards: r2Gc.subpartitionedShards,
    };
  },
);
