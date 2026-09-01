import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command, computed, type Computed } from "ccstate";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
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
import {
  decodeChatEventSnapshotBody,
  repairMorningBriefPhaseBSnapshot,
} from "./chat-event-snapshot-body.service";

const log = logger("api:cron:snapshot-chat-events");

interface ChatEventSnapshotStats {
  readonly snapshots: number;
  readonly archivedEvents: number;
  readonly unreadableParents: number;
  readonly skippedUnreadableHeads: number;
  readonly skippedUndecodableHeads: number;
  readonly skippedIncompleteHeads: number;
  readonly duplicateEventIdConflictThreads: number;
  readonly duplicateEventIdConflicts: number;
  readonly duplicateEventIdsRemapped: number;
  readonly duplicateEventReferencesRemapped: number;
  readonly r2ObjectsScanned: number;
  readonly r2ObjectsMeasured: number;
  readonly r2ObjectsDeleted: number;
  readonly r2BytesMeasured: number;
  readonly r2BytesDeleted: number;
  readonly r2GcShardsScanned: number;
  readonly r2GcSubpartitionedShards: number;
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
  readonly headTerminalSeqId: number | null;
  readonly headTerminalEventId: string | null;
  readonly headObjectKey: string | null;
  readonly headArchiveSchemaVersion: number | null;
}

/**
 * Version of the Chat Event row contract stored in Snapshot NDJSON. Bump it
 * whenever the row schema changes; object encoding remains gzip NDJSON.
 */
const ARCHIVE_CONTENT_TYPE = "application/x-ndjson";
const ARCHIVE_CONTENT_ENCODING = "gzip";
/** V7 wire shape is unchanged; this marks objects validated after Phase B. */
const ARCHIVE_ROW_CONTRACT_REVISION = 1;
const ARCHIVE_OBJECT_KEY_PREFIX_PATTERN = "^chat-events/[0-9a-f-]{36}/[0-9]+";
const ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN = "-[0-9a-f]{64}[.]ndjson[.]gz$";
const LEGACY_ARCHIVE_OBJECT_KEY_PATTERN = `${ARCHIVE_OBJECT_KEY_PREFIX_PATTERN}${ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN}`;
const CURRENT_ARCHIVE_OBJECT_KEY_PATTERN = `${ARCHIVE_OBJECT_KEY_PREFIX_PATTERN}-r${ARCHIVE_ROW_CONTRACT_REVISION.toString()}${ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN}`;
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
  return `chat-events/${chatThreadId}/${lastSeqId}-r${ARCHIVE_ROW_CONTRACT_REVISION.toString()}-${contentSha256}.ndjson.gz`;
}

export function isCurrentChatEventSnapshotObjectKey(
  objectKey: string,
): boolean {
  return new RegExp(CURRENT_ARCHIVE_OBJECT_KEY_PATTERN, "u").test(objectKey);
}

export function isLegacyChatEventSnapshotObjectKey(objectKey: string): boolean {
  return new RegExp(LEGACY_ARCHIVE_OBJECT_KEY_PATTERN, "u").test(objectKey);
}

interface CanonicalEventArchive {
  readonly lines: readonly Buffer[];
  readonly count: number;
  readonly lastPhysicalEventId: string | null;
  readonly lastRetainedEventId: string | null;
  readonly lastRetainedSeqId: number | null;
  readonly lastSeqId: number;
}

async function readCanonicalEvents(
  db: Db,
  candidate: SnapshotCandidate,
  fromSeqId: number,
): Promise<CanonicalEventArchive> {
  const lines: Buffer[] = [];
  let cursor = fromSeqId;
  let count = 0;
  let lastPhysicalEventId: string | null = null;
  let lastRetainedEventId: string | null = null;
  let lastRetainedSeqId: number | null = null;
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
      lastPhysicalEventId = row.id;
      lines.push(archiveLine(row));
      lastRetainedEventId = row.id;
      lastRetainedSeqId = row.seqId;
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
        lastPhysicalEventId,
        lastRetainedEventId,
        lastRetainedSeqId,
        lastSeqId: candidate.indexedSeqId,
      };
    }
  }
}

interface SnapshotSource {
  readonly id: string;
  readonly lastSeqId: number;
  readonly lastEventId: string;
  readonly terminalSeqId: number | null;
  readonly terminalEventId: string | null;
  readonly objectKey: string;
  readonly schemaVersion: number;
}

type SnapshotSkipReason = "unreadable" | "undecodable" | "incomplete";
type SnapshotDecodeFailureClass =
  | "checksum"
  | "gzip"
  | "raw_row"
  | "projection"
  | "prefix"
  | "terminal";

class SnapshotDecodeFailure extends Error {
  readonly failureClass: SnapshotDecodeFailureClass;

  constructor(failureClass: SnapshotDecodeFailureClass) {
    super("Chat Event Snapshot decode failed");
    this.name = "SnapshotDecodeFailure";
    this.failureClass = failureClass;
  }
}

type SnapshotSkippedResolution =
  | {
      readonly kind: "skipped";
      readonly reason: "unreadable" | "incomplete";
    }
  | {
      readonly kind: "skipped";
      readonly reason: "undecodable";
      readonly failureClass: SnapshotDecodeFailureClass;
    };

type SnapshotSourceResolution =
  | { readonly kind: "initial" }
  | { readonly kind: "reusable"; readonly source: SnapshotSource }
  | SnapshotSkippedResolution;

interface SnapshotSourceMetadata {
  readonly id: string;
  readonly lastSeqId: number | null;
  readonly lastEventId: string | null;
  readonly terminalSeqId: number | null;
  readonly terminalEventId: string | null;
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
  if (
    !(
      (source.terminalSeqId === 0 && source.terminalEventId === null) ||
      (source.terminalSeqId !== null &&
        source.terminalSeqId > 0 &&
        source.terminalSeqId <= source.lastSeqId &&
        source.terminalEventId !== null)
    )
  ) {
    return { kind: "skipped", reason: "incomplete" };
  }
  return {
    kind: "reusable",
    source: {
      id: source.id,
      lastSeqId: source.lastSeqId,
      lastEventId: source.lastEventId,
      terminalSeqId: source.terminalSeqId,
      terminalEventId: source.terminalEventId,
      objectKey: source.objectKey,
      schemaVersion: source.schemaVersion,
    },
  };
}

function candidateSourceResolution(
  candidate: SnapshotCandidate,
): SnapshotSourceResolution {
  return resolveSnapshotSource(
    candidate.headId === null
      ? undefined
      : {
          id: candidate.headId,
          lastSeqId: candidate.headLastSeqId,
          lastEventId: candidate.headLastEventId,
          terminalSeqId: candidate.headTerminalSeqId,
          terminalEventId: candidate.headTerminalEventId,
          objectKey: candidate.headObjectKey,
          schemaVersion: candidate.headArchiveSchemaVersion,
        },
  );
}

function candidateCurrentSource(
  candidate: SnapshotCandidate,
): SnapshotSource | null {
  const resolved = candidateSourceResolution(candidate);
  if (resolved.kind === "initial") {
    return null;
  }
  if (resolved.kind === "skipped") {
    throw new Error("Chat Event Snapshot pointer is not reusable");
  }
  return resolved.source;
}

type SnapshotPrefixResolution =
  | {
      readonly kind: "reusable";
      readonly body: Buffer;
      readonly terminalSeqId: number;
      readonly terminalEventId: string | null;
    }
  | SnapshotSkippedResolution;

interface SnapshotPrefixArgs {
  readonly bucket: string;
  readonly chatThreadId: string;
  readonly source: SnapshotSource;
}

function validateSnapshotPrefixRows(
  rows: readonly ChatEventRow[],
  args: SnapshotPrefixArgs,
): void {
  for (const [index, row] of rows.entries()) {
    if (
      row.chatThreadId !== args.chatThreadId ||
      row.seqId > args.source.lastSeqId ||
      (index > 0 && row.seqId <= (rows[index - 1]?.seqId ?? 0))
    ) {
      throw new Error("Chat Event Snapshot body violates prefix ordering");
    }
  }
}

function validateSnapshotPrefixTerminal(
  args: SnapshotPrefixArgs,
  terminalSeqId: number,
  terminalEventId: string | null,
): void {
  if (
    args.source.terminalSeqId !== terminalSeqId ||
    args.source.terminalEventId !== terminalEventId
  ) {
    throw new Error(
      "Chat Event Snapshot body does not match its terminal cursor",
    );
  }
}

async function decodeSnapshotStage<T>(
  failureClass: SnapshotDecodeFailureClass,
  decode: () => T | Promise<T>,
): Promise<T> {
  const decoded = await settle(
    (async () => {
      return await decode();
    })(),
  );
  if (!decoded.ok) {
    throw new SnapshotDecodeFailure(failureClass);
  }
  return decoded.value;
}

async function decodeSnapshotPrefix(
  compressed: Buffer,
  args: SnapshotPrefixArgs,
): Promise<{
  readonly body: Buffer;
  readonly terminalSeqId: number;
  readonly terminalEventId: string | null;
}> {
  const digest = /-([0-9a-f]{64})\.ndjson\.gz$/u.exec(
    args.source.objectKey,
  )?.[1];
  if (digest === undefined || sha256Hex(compressed) !== digest) {
    throw new SnapshotDecodeFailure("checksum");
  }
  const decompressed = await decodeSnapshotStage("gzip", async () => {
    return await gunzipAsync(compressed);
  });
  const decodedRows = await decodeSnapshotStage("raw_row", () => {
    return decodeChatEventSnapshotBody(decompressed);
  });
  const repaired = await decodeSnapshotStage("projection", () => {
    return repairMorningBriefPhaseBSnapshot(decompressed, decodedRows);
  });
  const rows = repaired.rows;
  await decodeSnapshotStage("prefix", () => {
    validateSnapshotPrefixRows(rows, args);
  });
  const terminal = rows.at(-1);
  const terminalSeqId = terminal?.seqId ?? 0;
  const terminalEventId = terminal?.id ?? null;
  await decodeSnapshotStage("terminal", () => {
    validateSnapshotPrefixTerminal(args, terminalSeqId, terminalEventId);
  });
  if (repaired.repairedContextRows > 0) {
    log.debug("Repaired retired Morning Brief Chat Event Snapshot rows", {
      type: "chat_event_snapshot_morning_brief_rows_repaired",
      chatThreadId: args.chatThreadId,
      repairedContextRows: repaired.repairedContextRows,
      removedDocumentParts: repaired.removedDocumentParts,
    });
  }
  return {
    body: repaired.body,
    terminalSeqId,
    terminalEventId,
  };
}

function readSnapshotPrefix(
  args: SnapshotPrefixArgs,
  signal: AbortSignal,
): Computed<Promise<SnapshotPrefixResolution>> {
  return computed(async (get): Promise<SnapshotPrefixResolution> => {
    const downloaded = await settle(
      get(downloadS3Buffer(args.bucket, args.source.objectKey)),
      signal,
    );
    if (!downloaded.ok) {
      return { kind: "skipped", reason: "unreadable" };
    }
    const decoded = await settle(
      decodeSnapshotPrefix(downloaded.value, args),
      signal,
    );
    if (decoded.ok) {
      return { kind: "reusable", ...decoded.value };
    }
    if (!(decoded.error instanceof SnapshotDecodeFailure)) {
      throw decoded.error;
    }
    return {
      kind: "skipped",
      reason: "undecodable",
      failureClass: decoded.error.failureClass,
    };
  });
}

function exactSnapshotPointer(source: SnapshotSource) {
  return and(
    eq(chatEventSnapshots.id, source.id),
    eq(chatEventSnapshots.lastSeqId, source.lastSeqId),
    eq(chatEventSnapshots.lastEventId, source.lastEventId),
    source.terminalSeqId === null
      ? isNull(chatEventSnapshots.terminalSeqId)
      : eq(chatEventSnapshots.terminalSeqId, source.terminalSeqId),
    source.terminalEventId === null
      ? isNull(chatEventSnapshots.terminalEventId)
      : eq(chatEventSnapshots.terminalEventId, source.terminalEventId),
    eq(chatEventSnapshots.objectKey, source.objectKey),
    eq(chatEventSnapshots.archiveSchemaVersion, source.schemaVersion),
  );
}

/** Publish the current pointer only if its exact source is still current. */
async function publishSnapshotVersion(
  db: Db,
  candidate: SnapshotCandidate,
  source: SnapshotSource | null,
  pointer: {
    readonly lastSeqId: number;
    readonly lastEventId: string;
    readonly terminalSeqId: number;
    readonly terminalEventId: string | null;
    readonly objectKey: string;
  },
): Promise<boolean> {
  const { lastSeqId, lastEventId, terminalSeqId, terminalEventId, objectKey } =
    pointer;
  return await db.transaction(async (tx) => {
    const current = candidateCurrentSource(candidate);
    if (source !== null && source.id !== current?.id) {
      const [lockedSource] = await tx
        .select({ id: chatEventSnapshots.id })
        .from(chatEventSnapshots)
        .where(exactSnapshotPointer(source))
        .for("update")
        .limit(1);
      if (lockedSource === undefined) {
        return false;
      }
    }
    if (current !== null) {
      const updated = await tx
        .update(chatEventSnapshots)
        .set({
          lastSeqId,
          lastEventId,
          terminalSeqId,
          terminalEventId,
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

    const [inserted] = await tx
      .insert(chatEventSnapshots)
      .values({
        chatThreadId: candidate.chatThreadId,
        lastSeqId,
        lastEventId,
        terminalSeqId,
        terminalEventId,
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
  resolution: SnapshotSkippedResolution,
): ArchivedThread {
  log.warn("Skipped Chat Event Snapshot pointer", {
    type: "chat_event_snapshot_head_skipped",
    chatThreadId: candidate.chatThreadId,
    reason: resolution.reason,
    ...(resolution.reason === "undecodable"
      ? { failureClass: resolution.failureClass }
      : {}),
  });
  return {
    archivedEvents: null,
    skippedHead: resolution.reason,
    normalization: NO_DUPLICATE_EVENT_ID_NORMALIZATION,
  };
}

type ArchivePrefixResolution =
  | {
      readonly kind: "reusable";
      readonly source: SnapshotSource | null;
      readonly prefix: Buffer | null;
      readonly terminalSeqId: number;
      readonly terminalEventId: string | null;
    }
  | SnapshotSkippedResolution;

function resolveArchivePrefix(
  args: {
    readonly bucket: string;
    readonly candidate: SnapshotCandidate;
  },
  signal: AbortSignal,
): Computed<Promise<ArchivePrefixResolution>> {
  return computed(async (get): Promise<ArchivePrefixResolution> => {
    const sourceResolution = candidateSourceResolution(args.candidate);
    signal.throwIfAborted();
    if (sourceResolution.kind === "skipped") {
      return sourceResolution;
    }
    if (sourceResolution.kind === "initial") {
      return {
        kind: "reusable",
        source: null,
        prefix: null,
        terminalSeqId: 0,
        terminalEventId: null,
      };
    }
    const prefixResolution = await get(
      readSnapshotPrefix(
        {
          bucket: args.bucket,
          chatThreadId: args.candidate.chatThreadId,
          source: sourceResolution.source,
        },
        signal,
      ),
    );
    if (prefixResolution.kind === "skipped") {
      return prefixResolution;
    }
    return {
      kind: "reusable",
      source: sourceResolution.source,
      prefix: prefixResolution.body,
      terminalSeqId: prefixResolution.terminalSeqId,
      terminalEventId: prefixResolution.terminalEventId,
    };
  });
}

function physicalSnapshotEventId(
  archiveLastEventId: string | null,
  source: SnapshotSource | null,
): string {
  const lastEventId = archiveLastEventId ?? source?.lastEventId;
  if (lastEventId === undefined) {
    throw new Error("Chat Event Snapshot has no terminal event ID");
  }
  return lastEventId;
}

function terminalSnapshotCursor(
  archive: {
    readonly lastRetainedEventId: string | null;
    readonly lastRetainedSeqId: number | null;
  },
  prefix: {
    readonly terminalEventId: string | null;
    readonly terminalSeqId: number;
  },
): { readonly eventId: string | null; readonly seqId: number } {
  if (archive.lastRetainedSeqId === null) {
    return {
      eventId: prefix.terminalEventId,
      seqId: prefix.terminalSeqId,
    };
  }
  if (archive.lastRetainedEventId === null) {
    throw new Error("Chat Event Snapshot retained cursor is incomplete");
  }
  return {
    eventId: archive.lastRetainedEventId,
    seqId: archive.lastRetainedSeqId,
  };
}

function isCurrentSnapshotWithoutTail(
  archiveEventCount: number,
  source: SnapshotSource | null,
): boolean {
  return (
    archiveEventCount === 0 &&
    source?.schemaVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION &&
    isCurrentChatEventSnapshotObjectKey(source.objectKey)
  );
}

interface PreparedSnapshotArchive {
  readonly body: Buffer;
  readonly terminalSeqId: number;
  readonly terminalEventId: string | null;
  readonly normalization: DuplicateEventIdNormalizationStats;
}

function logDuplicateEventIdNormalization(
  chatThreadId: string,
  normalization: DuplicateEventIdNormalizationStats,
): void {
  if (normalization.conflictingEventIds === 0) {
    return;
  }
  log.warn("Normalized duplicate chat event IDs in snapshot", {
    type: "chat_event_snapshot_duplicate_ids_normalized",
    chatThreadId,
    conflictingEventIdCount: normalization.conflictingEventIds,
    remappedEventIdCount: normalization.remappedEventIds,
    remappedReferenceCount: normalization.remappedEventReferences,
  });
}

function prepareSnapshotArchive(
  candidate: SnapshotCandidate,
  prefix: Buffer | null,
  prefixTerminal: {
    readonly terminalSeqId: number;
    readonly terminalEventId: string | null;
  },
  archive: CanonicalEventArchive,
): PreparedSnapshotArchive {
  const terminal = terminalSnapshotCursor(archive, prefixTerminal);
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
  logDuplicateEventIdNormalization(
    candidate.chatThreadId,
    prepared.normalization,
  );
  const preparedRows = decodeChatEventSnapshotBody(prepared.body);
  for (const row of preparedRows) {
    chatEventFromRow(row);
  }
  const preparedTerminal = preparedRows.at(-1);
  const terminalSeqId = preparedTerminal?.seqId ?? 0;
  if (terminalSeqId !== terminal.seqId) {
    throw new Error("Chat Event Snapshot normalization changed event ordering");
  }
  return {
    ...prepared,
    terminalSeqId,
    terminalEventId: preparedTerminal?.id ?? null,
  };
}

function archivedThreadFromPublication(
  published:
    | { readonly ok: true; readonly value: boolean }
    | { readonly ok: false; readonly error: unknown },
  archiveCount: number,
  normalization: DuplicateEventIdNormalizationStats,
): ArchivedThread {
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
      normalization,
    };
  }
  return {
    archivedEvents: published.value ? archiveCount : null,
    skippedHead: null,
    normalization,
  };
}

const archiveThread$ = command(async function archiveThread(
  { get },
  args: {
    readonly db: Db;
    readonly bucket: string;
    readonly candidate: SnapshotCandidate;
  },
  signal: AbortSignal,
): Promise<ArchivedThread> {
  const { db, bucket, candidate } = args;
  const resolved = await get(
    resolveArchivePrefix({ bucket, candidate }, signal),
  );
  signal.throwIfAborted();
  if (resolved.kind === "skipped") {
    return skippedArchivedThread(candidate, resolved);
  }
  const { source, prefix, terminalSeqId, terminalEventId } = resolved;
  const targetSeqId = Math.max(candidate.indexedSeqId, source?.lastSeqId ?? 0);
  const archive = await readCanonicalEvents(
    db,
    { ...candidate, indexedSeqId: targetSeqId },
    source?.lastSeqId ?? 0,
  );
  signal.throwIfAborted();
  if (isCurrentSnapshotWithoutTail(archive.count, source)) {
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
  const lastEventId = physicalSnapshotEventId(
    archive.lastPhysicalEventId,
    source,
  );
  const prepared = prepareSnapshotArchive(
    candidate,
    prefix,
    {
      terminalSeqId,
      terminalEventId,
    },
    archive,
  );
  const compressed = await gzipAsync(prepared.body);
  signal.throwIfAborted();
  const objectKey = chatEventSnapshotObjectKey(
    candidate.chatThreadId,
    targetSeqId,
    sha256Hex(compressed),
  );
  const [existingObjectReference] = await db
    .select({ id: chatEventSnapshots.id })
    .from(chatEventSnapshots)
    .where(eq(chatEventSnapshots.objectKey, objectKey))
    .limit(1);
  signal.throwIfAborted();
  if (
    source?.objectKey !== objectKey &&
    existingObjectReference === undefined
  ) {
    await get(
      putImmutableS3Object(
        bucket,
        objectKey,
        compressed,
        ARCHIVE_CONTENT_TYPE,
        {
          signal,
          contentEncoding: ARCHIVE_CONTENT_ENCODING,
        },
      ),
    );
  }
  signal.throwIfAborted();

  const published = await settle(
    publishSnapshotVersion(db, candidate, source, {
      lastSeqId: targetSeqId,
      lastEventId,
      terminalSeqId: prepared.terminalSeqId,
      terminalEventId: prepared.terminalEventId,
      objectKey,
    }),
  );
  signal.throwIfAborted();
  return archivedThreadFromPublication(
    published,
    archive.count,
    prepared.normalization,
  );
});

/** Repair or extend one thread without running the global R2 garbage collector. */
export const refreshChatEventSnapshotThread$ = command(
  async (
    { set },
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [candidate] = await loadSnapshotCandidates(db, [chatThreadId]);
    signal.throwIfAborted();
    if (candidate === undefined) {
      return false;
    }
    const archived = await set(
      archiveThread$,
      {
        db,
        bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
        candidate,
      },
      signal,
    );
    signal.throwIfAborted();
    return archived.archivedEvents !== null;
  },
);

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

function chatEventSnapshotGcPrefixes(now: Date): readonly string[] {
  const slot = Math.floor(now.getTime() / R2_GC_SLOT_MS);
  const first = (slot * R2_GC_SHARDS_PER_RUN) % R2_GC_SHARD_COUNT;
  return Array.from({ length: R2_GC_SHARDS_PER_RUN }, (_, offset) => {
    const shard = (first + offset) % R2_GC_SHARD_COUNT;
    return `chat-events/${shard.toString(16).padStart(3, "0")}`;
  });
}

function boundedGcObjectPages(
  bucket: string,
  prefix: string,
): Computed<Promise<readonly (readonly S3Object[])[]>> {
  return computed(async (get) => {
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
  });
}

const collectR2SnapshotGarbage$ = command(
  async function collectR2SnapshotGarbage(
    { get },
    args: {
      readonly db: Db;
      readonly bucket: string;
      readonly options: R2GcOptions;
    },
    signal: AbortSignal,
  ): Promise<R2GcStats> {
    const { db, bucket, options } = args;
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
      const pages = await get(boundedGcObjectPages(bucket, prefix));
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
        const objectDeletion = settle(
          get(deleteS3Objects(bucket, garbageKeys)),
        );
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
  },
);

async function loadSnapshotCandidates(
  db: Db,
  chatThreadIds: readonly string[] | null,
): Promise<readonly SnapshotCandidate[]> {
  const rows = await db
    .select({
      chatThreadId: chatThreads.id,
      indexedSeqId: chatEventSearchMessageWatermarks.indexedSeqId,
      headId: currentSnapshot.id,
      headLastSeqId: currentSnapshot.lastSeqId,
      headLastEventId: currentSnapshot.lastEventId,
      headTerminalSeqId: currentSnapshot.terminalSeqId,
      headTerminalEventId: currentSnapshot.terminalEventId,
      headObjectKey: currentSnapshot.objectKey,
      headArchiveSchemaVersion: currentSnapshot.archiveSchemaVersion,
    })
    .from(chatThreads)
    .innerJoin(
      chatEventSearchMessageWatermarks,
      eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
    )
    .leftJoin(
      currentSnapshot,
      and(
        eq(currentSnapshot.chatThreadId, chatThreads.id),
        eq(
          currentSnapshot.archiveSchemaVersion,
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        ),
      ),
    )
    .where(
      and(
        chatThreadIds === null
          ? undefined
          : inArray(chatThreads.id, chatThreadIds),
        gt(chatEventSearchMessageWatermarks.indexedSeqId, 0),
        or(
          isNull(currentSnapshot.id),
          lt(
            currentSnapshot.lastSeqId,
            chatEventSearchMessageWatermarks.indexedSeqId,
          ),
          lte(currentSnapshot.lastSeqId, 0),
          isNull(currentSnapshot.terminalSeqId),
          sql`btrim(${currentSnapshot.objectKey}) = ''`,
          sql`NOT (${currentSnapshot.objectKey}
            ~ '-[0-9a-f]{64}[.]ndjson[.]gz$')`,
          sql`${currentSnapshot.objectKey}
            ~ ${LEGACY_ARCHIVE_OBJECT_KEY_PATTERN}`,
        ),
      ),
    )
    .orderBy(asc(chatThreads.lastMessageAt), asc(chatThreads.id))
    .limit(chatEventSnapshotThreadBatchSize());

  return rows.map((row): SnapshotCandidate => {
    return {
      chatThreadId: row.chatThreadId,
      indexedSeqId: row.indexedSeqId,
      headId: row.headId,
      headLastSeqId: row.headLastSeqId,
      headLastEventId: row.headLastEventId,
      headTerminalSeqId: row.headTerminalSeqId,
      headTerminalEventId: row.headTerminalEventId,
      headObjectKey: row.headObjectKey,
      headArchiveSchemaVersion: row.headArchiveSchemaVersion,
    };
  });
}

/**
 * Archives Chat Events into immutable, content-addressed R2 Snapshots. The
 * first Snapshot may bootstrap from the currently available Raw Event prefix,
 * whose sequence positions may start above 1 and contain gaps. Every later
 * refresh must reuse a stored Snapshot prefix and append only the Raw Event
 * tail after its paired cursor. Missing objects and incomplete pointers fail
 * closed because older Raw Events may be reclaimed. Publication uses an exact
 * pointer CAS, so a lost race can only leave a collectable orphan object.
 */
export const snapshotChatEvents$ = command(
  async (
    { set },
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
    let duplicateEventIdConflictThreads = 0;
    let duplicateEventIdConflicts = 0;
    let duplicateEventIdsRemapped = 0;
    let duplicateEventReferencesRemapped = 0;
    for (const candidate of candidates) {
      const archived = await set(
        archiveThread$,
        { db, bucket, candidate },
        signal,
      );
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
    const r2Gc = await set(
      collectR2SnapshotGarbage$,
      {
        db,
        bucket,
        options: {
          deleteQuota: SNAPSHOT_GC_DELETE_QUOTA,
          ownedObjectKeys,
        },
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
      duplicateEventIdConflictThreads,
      duplicateEventIdConflicts,
      duplicateEventIdsRemapped,
      duplicateEventReferencesRemapped,
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
