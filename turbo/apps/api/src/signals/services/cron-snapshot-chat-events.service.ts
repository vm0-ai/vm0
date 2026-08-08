import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { command, type Computed } from "ccstate";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatEventSearchWatermarks } from "@vm0/db/schema/chat-event-search";
import { chatEventSnapshots } from "@vm0/db/schema/chat-event-snapshot";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { env, optionalEnv } from "../../lib/env";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-errors";
import { writeDb$, type Db } from "../external/db";
import { downloadS3Buffer, putImmutableS3Object } from "../external/s3";
import { settle } from "../utils";

type ComputedGetter = <T>(computedValue: Computed<T>) => T;

interface ChatEventSnapshotStats {
  readonly snapshots: number;
  readonly archivedEvents: number;
}

interface SnapshotCandidate {
  readonly chatThreadId: string;
  readonly indexedSeqId: number;
  readonly headId: string | null;
  readonly headLastSeqId: number | null;
  readonly headObjectKey: string | null;
}

/**
 * Version of the NDJSON line shape written by archiveLine. Bump it whenever
 * that shape changes; existing objects keep their recorded version and get
 * rewritten to the current one on the next rebuild of their thread.
 */
const ARCHIVE_SCHEMA_VERSION = 1;
const ARCHIVE_CONTENT_TYPE = "application/gzip";
const DEFAULT_THREAD_BATCH_SIZE = 25;
const EVENT_PAGE_SIZE = 1000;
const OBJECT_KEY_CONTENT_SHA256 = /-([0-9a-f]{64})\.ndjson\.gz$/;

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

/**
 * One archived chat event, one NDJSON line. Fields are listed explicitly so
 * that a chat_events schema change forces a conscious decision here instead
 * of silently changing the persisted archive shape.
 */
function archiveLine(row: typeof chatEvents.$inferSelect): Buffer {
  return Buffer.from(
    `${JSON.stringify({
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
      activeInputSequence: row.activeInputSequence,
      runEventSequenceNumber: row.runEventSequenceNumber,
      runEventId: row.runEventId,
      seqId: row.seqId,
      // Archive keys track the physical columns; the legacy* accessors are
      // the Stage 5 bridge names for goal_event, attach_files,
      // generation_template, and recommended_followups (vm0-ai/vm0#25767).
      goalEvent: row.legacyGoalPayload,
      attachFiles: row.legacyAttachedFiles,
      generationTemplate: row.legacyTemplatePayload,
      recommendedFollowups: row.legacyFollowupsPayload,
      createdAt: row.createdAt.toISOString(),
    })}\n`,
  );
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
      .select()
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
  if (tail.count === 0) {
    return null;
  }

  // The parent object is the only source for the archived prefix: Postgres
  // payloads below the head watermark are reclaimed later, so rebuilds never
  // query that range. Re-reading the parent also re-verifies its hash.
  let parentRaw: Buffer = Buffer.alloc(0);
  if (candidate.headObjectKey !== null) {
    const parentCompressed = await get(
      downloadS3Buffer(bucket, candidate.headObjectKey),
    );
    signal.throwIfAborted();
    parentRaw = verifiedArchiveRaw(candidate.headObjectKey, parentCompressed);
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
    const candidates = await db
      .select({
        chatThreadId: chatThreads.id,
        indexedSeqId: chatEventSearchWatermarks.indexedSeqId,
        headId: chatEventSnapshots.id,
        headLastSeqId: chatEventSnapshots.lastSeqId,
        headObjectKey: chatEventSnapshots.objectKey,
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
        gt(
          chatEventSearchWatermarks.indexedSeqId,
          sql`COALESCE(${chatEventSnapshots.lastSeqId}, 0)`,
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
    return { snapshots, archivedEvents };
  },
);
