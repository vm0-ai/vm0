import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import {
  chatEventRowSchema,
  chatEventRowV7Schema,
  downgradeChatEventRowToV7,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventSchemaVersion,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
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
import {
  chatEventSnapshotScanState,
  chatEventSnapshots,
} from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-errors";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  downloadS3Buffer,
  listS3ObjectsPage,
  putImmutableS3Object,
  type S3Object,
} from "../external/s3";
import { awaitWithSignal, settle, settleIncludingAbort } from "../utils";
import {
  NO_DUPLICATE_EVENT_ID_NORMALIZATION,
  prepareChatEventArchiveWithNormalizedIds,
  type DuplicateEventIdNormalizationStats,
} from "./chat-event-snapshot-duplicate-id-normalization";
import {
  ChatEventSnapshotProjectionError,
  decodeChatEventSnapshotBody,
  type ChatEventSnapshotProjectionSubstage,
  type ChatEventSnapshotProjectionVariant,
  validateChatEventSnapshotRows,
} from "./chat-event-snapshot-body.service";

const log = logger("api:cron:snapshot-chat-events");

interface ChatEventSnapshotStats {
  readonly snapshots: number;
  readonly archivedEvents: number;
  readonly selectedCandidates: number;
  readonly processedCandidates: number;
  readonly deferredCandidates: number;
  readonly unreadableParents: number;
  readonly skippedUnreadableHeads: number;
  readonly skippedUndecodableHeads: number;
  readonly skippedIncompleteHeads: number;
  readonly skippedFailedHeads: number;
  readonly skippedTimedOutHeads: number;
  readonly scanCursorAdvanced: boolean;
  readonly scanWrapped: boolean;
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
  readonly previousHeadId: string | null;
  readonly previousHeadLastSeqId: number | null;
  readonly previousHeadLastEventId: string | null;
  readonly previousHeadTerminalSeqId: number | null;
  readonly previousHeadTerminalEventId: string | null;
  readonly previousHeadObjectKey: string | null;
  readonly previousHeadArchiveSchemaVersion: number | null;
}

/**
 * Version of the Chat Event row contract stored in Snapshot NDJSON. Bump it
 * whenever the row schema changes; object encoding remains gzip NDJSON.
 */
const ARCHIVE_CONTENT_TYPE = "application/x-ndjson";
const ARCHIVE_CONTENT_ENCODING = "gzip";
/** V7 wire shape is unchanged; this marks objects validated after Phase B. */
const PREVIOUS_ARCHIVE_ROW_CONTRACT_REVISION = 1;
const CURRENT_ARCHIVE_ROW_CONTRACT_REVISION = 2;
const ARCHIVE_OBJECT_KEY_PREFIX_PATTERN = "^chat-events/[0-9a-f-]{36}/[0-9]+";
const ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN = "-[0-9a-f]{64}[.]ndjson[.]gz$";
const LEGACY_ARCHIVE_OBJECT_KEY_PATTERN = `${ARCHIVE_OBJECT_KEY_PREFIX_PATTERN}${ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN}`;
const PREVIOUS_ARCHIVE_OBJECT_KEY_PATTERN = `${ARCHIVE_OBJECT_KEY_PREFIX_PATTERN}-r${PREVIOUS_ARCHIVE_ROW_CONTRACT_REVISION.toString()}${ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN}`;
const CURRENT_ARCHIVE_OBJECT_KEY_PATTERN = `${ARCHIVE_OBJECT_KEY_PREFIX_PATTERN}-r${CURRENT_ARCHIVE_ROW_CONTRACT_REVISION.toString()}${ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN}`;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
/**
 * At the 10-minute cron cadence this cap permits 144k changed threads per day.
 * Normal traffic re-archives roughly 700 active threads per day, so the cap
 * leaves ample room for bursts while keeping each invocation bounded.
 */
const DEFAULT_THREAD_BATCH_SIZE = 1000;
const SNAPSHOT_THREAD_CONCURRENCY = 8;
const SNAPSHOT_THREAD_TIMEOUT_MS = 30 * 1000;
/**
 * Stop starting new thread work after two minutes. A final per-thread timeout
 * can extend the worker phase to 2.5 minutes, leaving half of the platform's
 * five-minute request window for candidate reads, GC, cursor CAS, and terminal
 * completion accounting.
 */
const SNAPSHOT_THREAD_START_BUDGET_MS = 2 * 60 * 1000;
const GLOBAL_SNAPSHOT_SCAN_SCOPE = "global";
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
const previousSnapshot = alias(
  chatEventSnapshots,
  "previous_chat_event_snapshot",
);

type ArchiveEventRow = Pick<
  typeof chatEvents.$inferSelect,
  | "id"
  | "chatThreadId"
  | "runId"
  | "revokesEventId"
  | "eventType"
  | "payload"
  | "failureReason"
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
    ...(row.eventType === "run.failed" && row.failureReason !== null
      ? { failureReason: row.failureReason }
      : {}),
    contextType: row.contextType,
    contextId: row.contextId,
    runEventSequenceNumber: row.runEventSequenceNumber,
    runEventId: row.runEventId,
    seqId: row.seqId,
    createdAt: row.createdAt.toISOString(),
  });
}

export function chatEventRowForSchemaVersion(
  row: ChatEventRow,
  schemaVersion: ChatEventSchemaVersion,
): ChatEventRow {
  return schemaVersion === PREVIOUS_CHAT_EVENT_SCHEMA_VERSION
    ? downgradeChatEventRowToV7(row)
    : row;
}

function archiveLine(
  row: ArchiveEventRow,
  schemaVersion: ChatEventSchemaVersion,
): Buffer {
  return encodeArchiveLine(
    chatEventRowForSchemaVersion(chatEventRowFromDbRow(row), schemaVersion),
  );
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function chatEventSnapshotObjectKey(
  chatThreadId: string,
  lastSeqId: number,
  schemaVersion: ChatEventSchemaVersion,
  contentSha256: string,
): string {
  const revision =
    schemaVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION
      ? CURRENT_ARCHIVE_ROW_CONTRACT_REVISION
      : PREVIOUS_ARCHIVE_ROW_CONTRACT_REVISION;
  return `chat-events/${chatThreadId}/${lastSeqId}-r${revision.toString()}-${contentSha256}.ndjson.gz`;
}

export function isCurrentChatEventSnapshotObjectKey(
  objectKey: string,
): boolean {
  return new RegExp(CURRENT_ARCHIVE_OBJECT_KEY_PATTERN, "u").test(objectKey);
}

export function isLegacyChatEventSnapshotObjectKey(objectKey: string): boolean {
  return new RegExp(LEGACY_ARCHIVE_OBJECT_KEY_PATTERN, "u").test(objectKey);
}

export function isPreviousChatEventSnapshotObjectKey(
  objectKey: string,
): boolean {
  return new RegExp(PREVIOUS_ARCHIVE_OBJECT_KEY_PATTERN, "u").test(objectKey);
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
        failureReason: chatEvents.failureReason,
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
      lines.push(archiveLine(row, CURRENT_CHAT_EVENT_SCHEMA_VERSION));
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
  | "revision"
  | "projection"
  | "prefix"
  | "terminal";

class SnapshotDecodeFailure extends Error {
  readonly failureClass: SnapshotDecodeFailureClass;
  readonly projectionSubstage: ChatEventSnapshotProjectionSubstage | undefined;
  readonly projectionVariant: ChatEventSnapshotProjectionVariant | undefined;

  constructor(
    failureClass: SnapshotDecodeFailureClass,
    projectionFailure?: ChatEventSnapshotProjectionError,
  ) {
    super("Chat Event Snapshot decode failed");
    this.name = "SnapshotDecodeFailure";
    this.failureClass = failureClass;
    this.projectionSubstage = projectionFailure?.projectionSubstage;
    this.projectionVariant = projectionFailure?.projectionVariant;
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
      readonly projectionSubstage?: ChatEventSnapshotProjectionSubstage;
      readonly projectionVariant?: ChatEventSnapshotProjectionVariant;
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
  const supportedObjectKey =
    source.schemaVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION
      ? isCurrentChatEventSnapshotObjectKey(source.objectKey) ||
        isLegacyChatEventSnapshotObjectKey(source.objectKey)
      : source.schemaVersion === PREVIOUS_CHAT_EVENT_SCHEMA_VERSION &&
        (isPreviousChatEventSnapshotObjectKey(source.objectKey) ||
          isLegacyChatEventSnapshotObjectKey(source.objectKey));
  if (!supportedObjectKey) {
    return {
      kind: "skipped",
      reason: "undecodable",
      failureClass: "revision",
    };
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

function candidateVersionSourceResolution(
  candidate: SnapshotCandidate,
  schemaVersion: ChatEventSchemaVersion,
): SnapshotSourceResolution {
  const current = schemaVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION;
  const id = current ? candidate.headId : candidate.previousHeadId;
  if (id === null) {
    return resolveSnapshotSource(undefined);
  }
  return resolveSnapshotSource({
    id,
    lastSeqId: current
      ? candidate.headLastSeqId
      : candidate.previousHeadLastSeqId,
    lastEventId: current
      ? candidate.headLastEventId
      : candidate.previousHeadLastEventId,
    terminalSeqId: current
      ? candidate.headTerminalSeqId
      : candidate.previousHeadTerminalSeqId,
    terminalEventId: current
      ? candidate.headTerminalEventId
      : candidate.previousHeadTerminalEventId,
    objectKey: current
      ? candidate.headObjectKey
      : candidate.previousHeadObjectKey,
    schemaVersion: current
      ? candidate.headArchiveSchemaVersion
      : candidate.previousHeadArchiveSchemaVersion,
  });
}

function candidateVersionSource(
  candidate: SnapshotCandidate,
  schemaVersion: ChatEventSchemaVersion,
): SnapshotSource | null {
  const resolved = candidateVersionSourceResolution(candidate, schemaVersion);
  if (resolved.kind === "initial") {
    return null;
  }
  if (resolved.kind === "skipped") {
    throw new Error("Chat Event Snapshot pointer is not reusable");
  }
  return resolved.source;
}

function candidateSourceResolution(
  candidate: SnapshotCandidate,
): SnapshotSourceResolution {
  const current = candidateVersionSourceResolution(
    candidate,
    CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  );
  const previous = candidateVersionSourceResolution(
    candidate,
    PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
  );
  if (current.kind === "skipped") {
    return current;
  }
  if (previous.kind === "skipped") {
    return previous;
  }
  if (current.kind === "initial") {
    return previous;
  }
  if (previous.kind === "initial") {
    return current;
  }
  if (current.source.lastSeqId >= previous.source.lastSeqId) {
    return current;
  }
  return previous;
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
    throw new SnapshotDecodeFailure(
      failureClass,
      decoded.error instanceof ChatEventSnapshotProjectionError
        ? decoded.error
        : undefined,
    );
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
    const rows = decodeChatEventSnapshotBody(decompressed);
    if (args.source.schemaVersion === PREVIOUS_CHAT_EVENT_SCHEMA_VERSION) {
      for (const row of rows) {
        chatEventRowV7Schema.parse(row);
      }
    }
    return rows;
  });
  await decodeSnapshotStage("projection", () => {
    validateChatEventSnapshotRows(decodedRows);
  });
  await decodeSnapshotStage("prefix", () => {
    validateSnapshotPrefixRows(decodedRows, args);
  });
  const terminal = decodedRows.at(-1);
  const terminalSeqId = terminal?.seqId ?? 0;
  const terminalEventId = terminal?.id ?? null;
  await decodeSnapshotStage("terminal", () => {
    validateSnapshotPrefixTerminal(args, terminalSeqId, terminalEventId);
  });
  return {
    body: decompressed,
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
      get(downloadS3Buffer(args.bucket, args.source.objectKey, signal)),
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
      ...(decoded.error.projectionSubstage === undefined ||
      decoded.error.projectionVariant === undefined
        ? {}
        : {
            projectionSubstage: decoded.error.projectionSubstage,
            projectionVariant: decoded.error.projectionVariant,
          }),
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

interface SnapshotPublication {
  readonly schemaVersion: ChatEventSchemaVersion;
  readonly lastSeqId: number;
  readonly lastEventId: string;
  readonly terminalSeqId: number;
  readonly terminalEventId: string | null;
  readonly objectKey: string;
}

async function lockExpectedSnapshotPointer(
  tx: Db,
  chatThreadId: string,
  schemaVersion: ChatEventSchemaVersion,
  source: SnapshotSource | null,
): Promise<boolean> {
  const [locked] = await tx
    .select({ id: chatEventSnapshots.id })
    .from(chatEventSnapshots)
    .where(
      source === null
        ? and(
            eq(chatEventSnapshots.chatThreadId, chatThreadId),
            eq(chatEventSnapshots.archiveSchemaVersion, schemaVersion),
          )
        : exactSnapshotPointer(source),
    )
    .for("update")
    .limit(1);
  return source === null ? locked === undefined : locked !== undefined;
}

async function writeSnapshotPointer(
  tx: Db,
  chatThreadId: string,
  source: SnapshotSource | null,
  pointer: SnapshotPublication,
): Promise<void> {
  if (source === null) {
    await tx.insert(chatEventSnapshots).values({
      chatThreadId,
      lastSeqId: pointer.lastSeqId,
      lastEventId: pointer.lastEventId,
      terminalSeqId: pointer.terminalSeqId,
      terminalEventId: pointer.terminalEventId,
      archiveSchemaVersion: pointer.schemaVersion,
      objectKey: pointer.objectKey,
    });
    return;
  }
  await tx
    .update(chatEventSnapshots)
    .set({
      lastSeqId: pointer.lastSeqId,
      lastEventId: pointer.lastEventId,
      terminalSeqId: pointer.terminalSeqId,
      terminalEventId: pointer.terminalEventId,
      objectKey: pointer.objectKey,
      createdAt: nowDate(),
    })
    .where(exactSnapshotPointer(source));
}

/** Publish V7 and V8 only while both exact observed sources remain current. */
async function publishSnapshotVersions(
  db: Db,
  candidate: SnapshotCandidate,
  pointers: readonly [SnapshotPublication, SnapshotPublication],
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const sources = new Map<ChatEventSchemaVersion, SnapshotSource | null>([
      [
        PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
        candidateVersionSource(candidate, PREVIOUS_CHAT_EVENT_SCHEMA_VERSION),
      ],
      [
        CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        candidateVersionSource(candidate, CURRENT_CHAT_EVENT_SCHEMA_VERSION),
      ],
    ]);
    for (const pointer of pointers) {
      const source = sources.get(pointer.schemaVersion);
      if (source === undefined) {
        throw new Error("Chat Event Snapshot publication source is missing");
      }
      if (
        !(await lockExpectedSnapshotPointer(
          tx,
          candidate.chatThreadId,
          pointer.schemaVersion,
          source,
        ))
      ) {
        return false;
      }
    }
    for (const pointer of pointers) {
      const source = sources.get(pointer.schemaVersion);
      if (source === undefined) {
        throw new Error("Chat Event Snapshot publication source is missing");
      }
      await writeSnapshotPointer(tx, candidate.chatThreadId, source, pointer);
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
      ? {
          failureClass: resolution.failureClass,
          ...(resolution.projectionSubstage === undefined ||
          resolution.projectionVariant === undefined
            ? {}
            : {
                projectionSubstage: resolution.projectionSubstage,
                projectionVariant: resolution.projectionVariant,
              }),
        }
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
  validateChatEventSnapshotRows(preparedRows);
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

function snapshotBodyForSchemaVersion(
  currentBody: Buffer,
  schemaVersion: ChatEventSchemaVersion,
): Buffer {
  if (schemaVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION) {
    return currentBody;
  }
  return Buffer.concat(
    decodeChatEventSnapshotBody(currentBody).map((row) => {
      return encodeArchiveLine(
        chatEventRowForSchemaVersion(row, schemaVersion),
      );
    }),
  );
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
  const versions = [
    PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
    CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  ] as const;
  const compressedBodies = await Promise.all(
    versions.map(async (schemaVersion) => {
      const compressed = await gzipAsync(
        snapshotBodyForSchemaVersion(prepared.body, schemaVersion),
      );
      const objectKey = chatEventSnapshotObjectKey(
        candidate.chatThreadId,
        targetSeqId,
        schemaVersion,
        sha256Hex(compressed),
      );
      return { schemaVersion, compressed, objectKey };
    }),
  );
  signal.throwIfAborted();
  const existingObjectReferences = await db
    .select({ objectKey: chatEventSnapshots.objectKey })
    .from(chatEventSnapshots)
    .where(
      inArray(
        chatEventSnapshots.objectKey,
        compressedBodies.map((body) => {
          return body.objectKey;
        }),
      ),
    );
  signal.throwIfAborted();
  const referencedObjectKeys = new Set(
    existingObjectReferences.map((reference) => {
      return reference.objectKey;
    }),
  );
  for (const body of compressedBodies) {
    if (referencedObjectKeys.has(body.objectKey)) {
      continue;
    }
    await get(
      putImmutableS3Object(
        bucket,
        body.objectKey,
        body.compressed,
        ARCHIVE_CONTENT_TYPE,
        {
          signal,
          contentEncoding: ARCHIVE_CONTENT_ENCODING,
        },
      ),
    );
  }
  signal.throwIfAborted();

  const publications = compressedBodies.map((body): SnapshotPublication => {
    return {
      schemaVersion: body.schemaVersion,
      lastSeqId: targetSeqId,
      lastEventId,
      terminalSeqId: prepared.terminalSeqId,
      terminalEventId: prepared.terminalEventId,
      objectKey: body.objectKey,
    };
  });
  const previousPublication = publications[0];
  const currentPublication = publications[1];
  if (previousPublication === undefined || currentPublication === undefined) {
    throw new Error("Chat Event Snapshot publication generation is incomplete");
  }
  const published = await settle(
    publishSnapshotVersions(db, candidate, [
      previousPublication,
      currentPublication,
    ]),
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
    const [candidate] = await loadSnapshotCandidates(
      db,
      [chatThreadId],
      null,
      null,
      1,
    );
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

interface SnapshotScanState {
  readonly cursorChatThreadId: string | null;
  readonly cycleUpperBoundLastMessageAt: Date;
}

interface SnapshotCandidatePage {
  readonly candidates: readonly SnapshotCandidate[];
  readonly expectedState: SnapshotScanState;
  readonly scanStartCursorChatThreadId: string | null;
  readonly cycleUpperBoundLastMessageAt: Date;
  readonly wrapped: boolean;
}

function snapshotCandidateAfterCursor(cursorChatThreadId: string | null) {
  return cursorChatThreadId === null
    ? undefined
    : gt(chatThreads.id, cursorChatThreadId);
}

function exactSnapshotScanCursor(cursorChatThreadId: string | null) {
  return cursorChatThreadId === null
    ? isNull(chatEventSnapshotScanState.cursorChatThreadId)
    : eq(chatEventSnapshotScanState.cursorChatThreadId, cursorChatThreadId);
}

async function loadSnapshotScanState(db: Db): Promise<SnapshotScanState> {
  const [state] = await db
    .select({
      cursorChatThreadId: chatEventSnapshotScanState.cursorChatThreadId,
      cycleUpperBoundLastMessageAt:
        chatEventSnapshotScanState.cycleUpperBoundLastMessageAt,
    })
    .from(chatEventSnapshotScanState)
    .where(eq(chatEventSnapshotScanState.scope, GLOBAL_SNAPSHOT_SCAN_SCOPE))
    .limit(1);
  if (state === undefined) {
    throw new Error("Global Chat Event Snapshot scan state is missing");
  }
  return state;
}

function sameSnapshotScanState(
  left: SnapshotScanState,
  right: SnapshotScanState,
): boolean {
  return (
    left.cursorChatThreadId === right.cursorChatThreadId &&
    left.cycleUpperBoundLastMessageAt.getTime() ===
      right.cycleUpperBoundLastMessageAt.getTime()
  );
}

async function advanceSnapshotScanState(
  db: Db,
  expected: SnapshotScanState,
  next: SnapshotScanState,
): Promise<boolean> {
  if (sameSnapshotScanState(expected, next)) {
    return false;
  }
  const [updated] = await db
    .update(chatEventSnapshotScanState)
    .set({
      cursorChatThreadId: next.cursorChatThreadId,
      cycleUpperBoundLastMessageAt: next.cycleUpperBoundLastMessageAt,
    })
    .where(
      and(
        eq(chatEventSnapshotScanState.scope, GLOBAL_SNAPSHOT_SCAN_SCOPE),
        exactSnapshotScanCursor(expected.cursorChatThreadId),
        eq(
          chatEventSnapshotScanState.cycleUpperBoundLastMessageAt,
          expected.cycleUpperBoundLastMessageAt,
        ),
      ),
    )
    .returning({ scope: chatEventSnapshotScanState.scope });
  return updated !== undefined;
}

async function loadSnapshotCandidates(
  db: Db,
  chatThreadIds: readonly string[] | null,
  cursorChatThreadId: string | null,
  cycleUpperBoundLastMessageAt: Date | null,
  limit: number,
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
      previousHeadId: previousSnapshot.id,
      previousHeadLastSeqId: previousSnapshot.lastSeqId,
      previousHeadLastEventId: previousSnapshot.lastEventId,
      previousHeadTerminalSeqId: previousSnapshot.terminalSeqId,
      previousHeadTerminalEventId: previousSnapshot.terminalEventId,
      previousHeadObjectKey: previousSnapshot.objectKey,
      previousHeadArchiveSchemaVersion: previousSnapshot.archiveSchemaVersion,
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
    .leftJoin(
      previousSnapshot,
      and(
        eq(previousSnapshot.chatThreadId, chatThreads.id),
        eq(
          previousSnapshot.archiveSchemaVersion,
          PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
        ),
      ),
    )
    .where(
      and(
        chatThreadIds === null
          ? undefined
          : inArray(chatThreads.id, chatThreadIds),
        snapshotCandidateAfterCursor(cursorChatThreadId),
        cycleUpperBoundLastMessageAt === null
          ? undefined
          : lte(chatThreads.lastMessageAt, cycleUpperBoundLastMessageAt),
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
          sql`NOT (${currentSnapshot.objectKey}
            ~ ${CURRENT_ARCHIVE_OBJECT_KEY_PATTERN})`,
          sql`${currentSnapshot.objectKey}
            ~ ${LEGACY_ARCHIVE_OBJECT_KEY_PATTERN}`,
          isNull(previousSnapshot.id),
          lt(
            previousSnapshot.lastSeqId,
            chatEventSearchMessageWatermarks.indexedSeqId,
          ),
          lte(previousSnapshot.lastSeqId, 0),
          isNull(previousSnapshot.terminalSeqId),
          sql`btrim(${previousSnapshot.objectKey}) = ''`,
          sql`NOT (${previousSnapshot.objectKey}
            ~ '-[0-9a-f]{64}[.]ndjson[.]gz$')`,
          sql`NOT (${previousSnapshot.objectKey}
            ~ ${PREVIOUS_ARCHIVE_OBJECT_KEY_PATTERN})`,
        ),
      ),
    )
    .orderBy(
      ...(chatThreadIds === null
        ? [asc(chatThreads.id)]
        : [asc(chatThreads.lastMessageAt), asc(chatThreads.id)]),
    )
    .limit(limit);

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
      previousHeadId: row.previousHeadId,
      previousHeadLastSeqId: row.previousHeadLastSeqId,
      previousHeadLastEventId: row.previousHeadLastEventId,
      previousHeadTerminalSeqId: row.previousHeadTerminalSeqId,
      previousHeadTerminalEventId: row.previousHeadTerminalEventId,
      previousHeadObjectKey: row.previousHeadObjectKey,
      previousHeadArchiveSchemaVersion: row.previousHeadArchiveSchemaVersion,
    };
  });
}

async function loadGlobalSnapshotCandidatePage(
  db: Db,
): Promise<SnapshotCandidatePage> {
  const state = await loadSnapshotScanState(db);
  const limit = chatEventSnapshotThreadBatchSize();
  const candidates = await loadSnapshotCandidates(
    db,
    null,
    state.cursorChatThreadId,
    state.cycleUpperBoundLastMessageAt,
    limit,
  );
  if (candidates.length > 0) {
    return {
      candidates,
      expectedState: state,
      scanStartCursorChatThreadId: state.cursorChatThreadId,
      cycleUpperBoundLastMessageAt: state.cycleUpperBoundLastMessageAt,
      wrapped: false,
    };
  }
  const cycleUpperBoundLastMessageAt = nowDate();
  return {
    candidates: await loadSnapshotCandidates(
      db,
      null,
      null,
      cycleUpperBoundLastMessageAt,
      limit,
    ),
    expectedState: state,
    scanStartCursorChatThreadId: null,
    cycleUpperBoundLastMessageAt,
    wrapped: true,
  };
}

type SnapshotCandidateOutcome =
  | { readonly kind: "completed"; readonly archived: ArchivedThread }
  | { readonly kind: "failed" }
  | { readonly kind: "timed_out" };

interface SnapshotCandidateBatch {
  readonly outcomes: readonly SnapshotCandidateOutcome[];
  readonly attemptedCandidates: number;
  readonly deferredCandidates: number;
}

interface SnapshotCandidateOutcomeStats {
  readonly snapshots: number;
  readonly archivedEvents: number;
  readonly unreadableParents: number;
  readonly skippedUnreadableHeads: number;
  readonly skippedUndecodableHeads: number;
  readonly skippedIncompleteHeads: number;
  readonly skippedFailedHeads: number;
  readonly skippedTimedOutHeads: number;
  readonly duplicateEventIdConflictThreads: number;
  readonly duplicateEventIdConflicts: number;
  readonly duplicateEventIdsRemapped: number;
  readonly duplicateEventReferencesRemapped: number;
}

async function processSnapshotCandidate(
  candidate: SnapshotCandidate,
  archive: (
    candidate: SnapshotCandidate,
    signal: AbortSignal,
  ) => Promise<ArchivedThread>,
  signal: AbortSignal,
): Promise<SnapshotCandidateOutcome> {
  const timeoutSignal = AbortSignal.timeout(SNAPSHOT_THREAD_TIMEOUT_MS);
  const candidateSignal = AbortSignal.any([signal, timeoutSignal]);
  const archived = await settleIncludingAbort(
    awaitWithSignal(archive(candidate, candidateSignal), candidateSignal),
  );
  signal.throwIfAborted();
  if (archived.ok) {
    return { kind: "completed", archived: archived.value };
  }
  if (timeoutSignal.aborted) {
    log.warn("Timed out Chat Event Snapshot candidate", {
      type: "chat_event_snapshot_candidate_timed_out",
      chatThreadId: candidate.chatThreadId,
    });
    return { kind: "timed_out" };
  }
  log.error("Failed Chat Event Snapshot candidate", {
    type: "chat_event_snapshot_candidate_failed",
    chatThreadId: candidate.chatThreadId,
    error: archived.error,
  });
  return { kind: "failed" };
}

async function processSnapshotCandidates(
  candidates: readonly SnapshotCandidate[],
  archive: (
    candidate: SnapshotCandidate,
    signal: AbortSignal,
  ) => Promise<ArchivedThread>,
  signal: AbortSignal,
): Promise<SnapshotCandidateBatch> {
  const startDeadline = now() + SNAPSHOT_THREAD_START_BUDGET_MS;
  const outcomes: (SnapshotCandidateOutcome | undefined)[] = Array.from({
    length: candidates.length,
  });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (now() >= startDeadline) {
        return;
      }
      const index = nextIndex;
      const candidate = candidates[index];
      if (candidate === undefined) {
        return;
      }
      nextIndex += 1;
      outcomes[index] = await processSnapshotCandidate(
        candidate,
        archive,
        signal,
      );
    }
  }

  const workerCount = Math.min(SNAPSHOT_THREAD_CONCURRENCY, candidates.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      await worker();
    }),
  );
  signal.throwIfAborted();

  const attemptedCandidates = nextIndex;
  return {
    outcomes: outcomes.slice(0, attemptedCandidates).map((outcome) => {
      if (outcome === undefined) {
        throw new Error("Missing Chat Event Snapshot candidate outcome");
      }
      return outcome;
    }),
    attemptedCandidates,
    deferredCandidates: candidates.length - attemptedCandidates,
  };
}

function summarizeSnapshotCandidateOutcomes(
  outcomes: readonly SnapshotCandidateOutcome[],
): SnapshotCandidateOutcomeStats {
  const stats = {
    snapshots: 0,
    archivedEvents: 0,
    unreadableParents: 0,
    skippedUnreadableHeads: 0,
    skippedUndecodableHeads: 0,
    skippedIncompleteHeads: 0,
    skippedFailedHeads: 0,
    skippedTimedOutHeads: 0,
    duplicateEventIdConflictThreads: 0,
    duplicateEventIdConflicts: 0,
    duplicateEventIdsRemapped: 0,
    duplicateEventReferencesRemapped: 0,
  };
  for (const outcome of outcomes) {
    if (outcome.kind === "failed") {
      stats.skippedFailedHeads += 1;
      continue;
    }
    if (outcome.kind === "timed_out") {
      stats.skippedTimedOutHeads += 1;
      continue;
    }
    const archived = outcome.archived;
    if (archived.skippedHead === "unreadable") {
      stats.skippedUnreadableHeads += 1;
      stats.unreadableParents += 1;
    } else if (archived.skippedHead === "undecodable") {
      stats.skippedUndecodableHeads += 1;
      stats.unreadableParents += 1;
    } else if (archived.skippedHead === "incomplete") {
      stats.skippedIncompleteHeads += 1;
    }
    if (archived.archivedEvents !== null) {
      stats.snapshots += 1;
      stats.archivedEvents += archived.archivedEvents;
    }
    if (archived.normalization.conflictingEventIds > 0) {
      stats.duplicateEventIdConflictThreads += 1;
    }
    stats.duplicateEventIdConflicts +=
      archived.normalization.conflictingEventIds;
    stats.duplicateEventIdsRemapped += archived.normalization.remappedEventIds;
    stats.duplicateEventReferencesRemapped +=
      archived.normalization.remappedEventReferences;
  }
  return stats;
}

async function finalizeGlobalSnapshotScanState(
  db: Db,
  candidatePage: SnapshotCandidatePage,
  attemptedCandidates: number,
  signal: AbortSignal,
): Promise<boolean> {
  const lastAttempted = candidatePage.candidates[attemptedCandidates - 1];
  const nextCursorChatThreadId =
    lastAttempted === undefined
      ? candidatePage.candidates.length === 0
        ? null
        : candidatePage.scanStartCursorChatThreadId
      : lastAttempted.chatThreadId;
  const advanced = await advanceSnapshotScanState(
    db,
    candidatePage.expectedState,
    {
      cursorChatThreadId: nextCursorChatThreadId,
      cycleUpperBoundLastMessageAt: candidatePage.cycleUpperBoundLastMessageAt,
    },
  );
  signal.throwIfAborted();
  return advanced;
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
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const ownedObjectKeys =
      scope.kind === "global" ? null : new Set(scope.r2ObjectKeys);
    const globalCandidatePage =
      scope.kind === "global"
        ? await loadGlobalSnapshotCandidatePage(db)
        : null;
    const candidates =
      globalCandidatePage?.candidates ??
      (await loadSnapshotCandidates(
        db,
        scope.kind === "fixtures" ? scope.chatThreadIds : null,
        null,
        null,
        chatEventSnapshotThreadBatchSize(),
      ));
    signal.throwIfAborted();

    const processed = await processSnapshotCandidates(
      candidates,
      async (candidate, candidateSignal) => {
        return await set(
          archiveThread$,
          { db, bucket, candidate },
          candidateSignal,
        );
      },
      signal,
    );
    signal.throwIfAborted();

    const outcomeStats = summarizeSnapshotCandidateOutcomes(processed.outcomes);
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
    const scanCursorAdvanced =
      globalCandidatePage === null
        ? false
        : await finalizeGlobalSnapshotScanState(
            db,
            globalCandidatePage,
            processed.attemptedCandidates,
            signal,
          );
    return {
      ...outcomeStats,
      selectedCandidates: candidates.length,
      processedCandidates: processed.attemptedCandidates,
      deferredCandidates: processed.deferredCandidates,
      scanCursorAdvanced,
      scanWrapped: globalCandidatePage?.wrapped ?? false,
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
