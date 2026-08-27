import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
  CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command, computed, type Computed } from "ccstate";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
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
  encodeChatEventSnapshotBody,
  projectChatEventSnapshotRows,
} from "./chat-event-snapshot-body.service";
import { upgradeChatEventSnapshotBody } from "./chat-event-snapshot-upgrade.service";

const log = logger("api:cron:snapshot-chat-events");

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
  readonly canonicalSnapshotHeads: number;
  readonly pendingCanonicalSnapshotMigrations: number;
  readonly snapshotHeadVersions: readonly ChatEventSnapshotHeadVersion[];
}

interface ChatEventSnapshotHeadVersion {
  readonly archiveSchemaVersion: number;
  readonly heads: number;
}

interface ChatEventSnapshotConvergence {
  readonly snapshotHeads: number;
  readonly nonCurrentSnapshotHeads: number;
  readonly canonicalSnapshotHeads: number;
  readonly pendingCanonicalSnapshotMigrations: number;
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
  readonly projection: ChatEventSnapshotProjection;
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
const ARCHIVE_SCHEMA_VERSION = CURRENT_CHAT_EVENT_SCHEMA_VERSION;
const MINIMUM_UPGRADABLE_ARCHIVE_SCHEMA_VERSION = 5;
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
const currentToolRedactedSnapshot = alias(
  chatEventSnapshots,
  "current_tool_redacted_chat_event_snapshot",
);
const previousToolRedactedSnapshot = alias(
  chatEventSnapshots,
  "previous_tool_redacted_chat_event_snapshot",
);
const floorToolRedactedSnapshot = alias(
  chatEventSnapshots,
  "floor_tool_redacted_chat_event_snapshot",
);
const floorFullSnapshot = alias(
  chatEventSnapshots,
  "floor_full_chat_event_snapshot",
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
  return `chat-events/${chatThreadId}/${lastSeqId}-${contentSha256}.ndjson.gz`;
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
      if (candidate.projection === "full" || row.eventType !== "output.tool") {
        lines.push(archiveLine(row));
        lastRetainedEventId = row.id;
        lastRetainedSeqId = row.seqId;
      }
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
  readonly projection: ChatEventSnapshotProjection;
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
  readonly terminalSeqId: number | null;
  readonly terminalEventId: string | null;
  readonly objectKey: string | null;
  readonly schemaVersion: number | null;
  readonly projection: ChatEventSnapshotProjection;
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
    source.schemaVersion < MINIMUM_UPGRADABLE_ARCHIVE_SCHEMA_VERSION ||
    source.schemaVersion > CURRENT_CHAT_EVENT_SCHEMA_VERSION
  ) {
    return { kind: "skipped", reason: "unsupported" };
  }
  if (
    source.schemaVersion >= CURRENT_CHAT_EVENT_SCHEMA_VERSION &&
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
      projection: source.projection,
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
          terminalSeqId: candidate.headTerminalSeqId,
          terminalEventId: candidate.headTerminalEventId,
          objectKey: candidate.headObjectKey,
          schemaVersion: candidate.headArchiveSchemaVersion,
          projection: candidate.projection,
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
    const current = resolveSnapshotSource({
      id: candidate.headId,
      lastSeqId: candidate.headLastSeqId,
      lastEventId: candidate.headLastEventId,
      terminalSeqId: candidate.headTerminalSeqId,
      terminalEventId: candidate.headTerminalEventId,
      objectKey: candidate.headObjectKey,
      schemaVersion: candidate.headArchiveSchemaVersion,
      projection: candidate.projection,
    });
    // Never conceal a malformed current head by rebuilding from a legacy
    // source. It remains an explicit convergence blocker.
    if (current.kind === "skipped") {
      return current;
    }
  }
  const sources = await db
    .select({
      id: chatEventSnapshots.id,
      lastSeqId: chatEventSnapshots.lastSeqId,
      lastEventId: chatEventSnapshots.lastEventId,
      terminalSeqId: chatEventSnapshots.terminalSeqId,
      terminalEventId: chatEventSnapshots.terminalEventId,
      objectKey: chatEventSnapshots.objectKey,
      schemaVersion: chatEventSnapshots.archiveSchemaVersion,
      projection: chatEventSnapshots.projection,
    })
    .from(chatEventSnapshots)
    .where(
      and(
        eq(chatEventSnapshots.chatThreadId, candidate.chatThreadId),
        candidate.projection === "full"
          ? eq(chatEventSnapshots.projection, "full")
          : undefined,
      ),
    )
    .orderBy(
      desc(chatEventSnapshots.lastSeqId),
      desc(eq(chatEventSnapshots.projection, candidate.projection)),
      desc(chatEventSnapshots.archiveSchemaVersion),
      desc(chatEventSnapshots.createdAt),
      desc(chatEventSnapshots.id),
    );
  let blocked: SnapshotSourceResolution | null = null;
  for (const source of sources) {
    const resolved = resolveSnapshotSource(source);
    if (resolved.kind === "reusable") {
      return resolved;
    }
    if (resolved.kind === "skipped" && blocked === null) {
      blocked = resolved;
    }
  }
  return blocked ?? { kind: "initial" };
}

type SnapshotPrefixResolution =
  | {
      readonly kind: "reusable";
      readonly body: Buffer;
      readonly terminalSeqId: number;
      readonly terminalEventId: string | null;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "unreadable" | "undecodable";
    };

interface SnapshotPrefixArgs {
  readonly bucket: string;
  readonly chatThreadId: string;
  readonly source: SnapshotSource;
  readonly projection: ChatEventSnapshotProjection;
}

function validateSnapshotPrefixRows(
  rows: readonly ChatEventRow[],
  args: SnapshotPrefixArgs,
): void {
  for (const [index, row] of rows.entries()) {
    if (
      row.chatThreadId !== args.chatThreadId ||
      row.seqId > args.source.lastSeqId ||
      (args.source.projection === "tool-redacted" &&
        row.eventType === "output.tool") ||
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
    args.source.schemaVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION &&
    (args.source.terminalSeqId !== terminalSeqId ||
      args.source.terminalEventId !== terminalEventId)
  ) {
    throw new Error(
      "Chat Event Snapshot body does not match its terminal cursor",
    );
  }
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
    throw new Error(
      "Chat Event Snapshot object checksum does not match its key",
    );
  }
  const decompressed = await gunzipAsync(compressed);
  const sourceRows = decodeChatEventSnapshotBody(decompressed);
  if (
    args.source.projection === "full" &&
    sourceRows.at(-1)?.id !== args.source.lastEventId
  ) {
    throw new Error("Chat Event Snapshot body does not match its cursor");
  }
  const upgraded = upgradeChatEventSnapshotBody(
    decompressed,
    args.source.schemaVersion,
    CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  );
  const rows = decodeChatEventSnapshotBody(upgraded);
  if (args.projection === "full" && args.source.projection !== "full") {
    throw new Error("A full Snapshot cannot reuse a redacted prefix");
  }
  validateSnapshotPrefixRows(rows, args);
  const projectedRows = projectChatEventSnapshotRows(rows, args.projection);
  const terminal = projectedRows.at(-1);
  const terminalSeqId = terminal?.seqId ?? 0;
  const terminalEventId = terminal?.id ?? null;
  validateSnapshotPrefixTerminal(args, terminalSeqId, terminalEventId);
  return {
    body:
      args.source.projection === args.projection
        ? upgraded
        : encodeChatEventSnapshotBody(projectedRows),
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
    return decoded.ok
      ? { kind: "reusable", ...decoded.value }
      : { kind: "skipped", reason: "undecodable" };
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
    eq(chatEventSnapshots.projection, source.projection),
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
        projection: candidate.projection,
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
      readonly terminalSeqId: number;
      readonly terminalEventId: string | null;
    }
  | { readonly kind: "skipped"; readonly reason: SnapshotSkipReason };

function resolveArchivePrefix(
  args: {
    readonly db: Db;
    readonly bucket: string;
    readonly candidate: SnapshotCandidate;
  },
  signal: AbortSignal,
): Computed<Promise<ArchivePrefixResolution>> {
  return computed(async (get): Promise<ArchivePrefixResolution> => {
    const sourceResolution = await storedSnapshotSource(
      args.db,
      args.candidate,
    );
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
          projection: args.candidate.projection,
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
  projection: ChatEventSnapshotProjection,
): boolean {
  return (
    archiveEventCount === 0 &&
    source?.schemaVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION &&
    source.projection === projection
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
  const preparedTerminal = decodeChatEventSnapshotBody(prepared.body).at(-1);
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
    resolveArchivePrefix({ db, bucket, candidate }, signal),
  );
  signal.throwIfAborted();
  if (resolved.kind === "skipped") {
    return skippedArchivedThread(candidate, resolved.reason);
  }
  const { source, prefix, terminalSeqId, terminalEventId } = resolved;
  const targetSeqId = Math.max(candidate.indexedSeqId, source?.lastSeqId ?? 0);
  const archive = await readCanonicalEvents(
    db,
    { ...candidate, indexedSeqId: targetSeqId },
    source?.lastSeqId ?? 0,
  );
  signal.throwIfAborted();
  if (
    isCurrentSnapshotWithoutTail(archive.count, source, candidate.projection)
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

interface CurrentSnapshotMigrationHead {
  readonly headId: string;
  readonly headLastSeqId: number;
  readonly headLastEventId: string;
  readonly headTerminalSeqId: number | null;
  readonly headTerminalEventId: string | null;
  readonly headObjectKey: string;
  readonly headArchiveSchemaVersion: number;
}

interface CurrentSnapshotMigrationState {
  readonly indexedSeqId: number;
  readonly head: CurrentSnapshotMigrationHead | undefined;
  readonly legacyCoverageSeqId: number | null;
}

async function currentSnapshotMigrationState(
  db: Db,
  chatThreadId: string,
  projection: ChatEventSnapshotProjection,
): Promise<CurrentSnapshotMigrationState | null> {
  const [[thread], [head], [legacyCoverage]] = await Promise.all([
    db
      .select({ indexedSeqId: chatThreads.lastChatEventSeqId })
      .from(chatThreads)
      .where(eq(chatThreads.id, chatThreadId))
      .limit(1),
    db
      .select({
        headId: chatEventSnapshots.id,
        headLastSeqId: chatEventSnapshots.lastSeqId,
        headLastEventId: chatEventSnapshots.lastEventId,
        headTerminalSeqId: chatEventSnapshots.terminalSeqId,
        headTerminalEventId: chatEventSnapshots.terminalEventId,
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
          eq(chatEventSnapshots.projection, projection),
        ),
      )
      .limit(1),
    db
      .select({ lastSeqId: chatEventSnapshots.lastSeqId })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, chatThreadId),
          gte(
            chatEventSnapshots.archiveSchemaVersion,
            CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
          ),
          lt(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
        ),
      )
      .orderBy(desc(chatEventSnapshots.lastSeqId))
      .limit(1),
  ]);
  return thread === undefined
    ? null
    : {
        indexedSeqId: thread.indexedSeqId,
        head,
        legacyCoverageSeqId: legacyCoverage?.lastSeqId ?? null,
      };
}

function currentSnapshotMigrationCandidate(
  chatThreadId: string,
  projection: ChatEventSnapshotProjection,
  state: CurrentSnapshotMigrationState,
): SnapshotCandidate {
  const { head, legacyCoverageSeqId } = state;
  return {
    chatThreadId,
    indexedSeqId:
      head === undefined
        ? Math.max(state.indexedSeqId, legacyCoverageSeqId ?? 0)
        : (legacyCoverageSeqId ?? head.headLastSeqId),
    projection,
    headId: head?.headId ?? null,
    headLastSeqId: head?.headLastSeqId ?? null,
    headLastEventId: head?.headLastEventId ?? null,
    headTerminalSeqId: head?.headTerminalSeqId ?? null,
    headTerminalEventId: head?.headTerminalEventId ?? null,
    headObjectKey: head?.headObjectKey ?? null,
    headArchiveSchemaVersion: head?.headArchiveSchemaVersion ?? null,
  };
}

async function hasSnapshotMigrationSource(
  db: Db,
  candidate: SnapshotCandidate,
): Promise<boolean> {
  if (candidate.headId !== null) {
    return true;
  }
  const stored = await storedSnapshotSource(db, candidate);
  return stored.kind !== "initial";
}

/**
 * Persist the current-version pointer on demand from an existing Snapshot plus
 * its latest Raw Event tail. A thread with no Snapshot remains a normal cold
 * start and is left for the bounded cron.
 */
export const migrateCurrentChatEventSnapshot$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly projection: ChatEventSnapshotProjection;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { chatThreadId, projection } = args;
    if (projection !== CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION) {
      return false;
    }
    const db = set(writeDb$);
    const state = await currentSnapshotMigrationState(
      db,
      chatThreadId,
      projection,
    );
    signal.throwIfAborted();
    if (state === null) {
      return false;
    }
    if (
      state.head !== undefined &&
      state.head.headLastSeqId >= (state.legacyCoverageSeqId ?? 0)
    ) {
      return true;
    }
    const candidate = currentSnapshotMigrationCandidate(
      chatThreadId,
      projection,
      state,
    );
    const hasSource = await hasSnapshotMigrationSource(db, candidate);
    signal.throwIfAborted();
    if (!hasSource) {
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
    return archived.skippedHead === null;
  },
);

async function chatEventSnapshotConvergence(
  db: Db,
  chatThreadIds: readonly string[] | null,
): Promise<ChatEventSnapshotConvergence> {
  const [versions, canonicalRows, pendingRows] = await Promise.all([
    db
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
      .orderBy(asc(chatEventSnapshots.archiveSchemaVersion)),
    db
      .select({ heads: count() })
      .from(currentToolRedactedSnapshot)
      .where(
        and(
          eq(
            currentToolRedactedSnapshot.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
          eq(
            currentToolRedactedSnapshot.projection,
            CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
          ),
          isNotNull(currentToolRedactedSnapshot.terminalSeqId),
          sql`${currentToolRedactedSnapshot.objectKey}
            ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'`,
          chatThreadIds === null
            ? undefined
            : inArray(currentToolRedactedSnapshot.chatThreadId, chatThreadIds),
        ),
      ),
    db
      .select({
        heads: countDistinct(chatEventSnapshots.chatThreadId),
      })
      .from(chatEventSnapshots)
      .leftJoin(
        currentToolRedactedSnapshot,
        and(
          eq(
            currentToolRedactedSnapshot.chatThreadId,
            chatEventSnapshots.chatThreadId,
          ),
          eq(
            currentToolRedactedSnapshot.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
          eq(
            currentToolRedactedSnapshot.projection,
            CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
          ),
          gte(
            currentToolRedactedSnapshot.lastSeqId,
            chatEventSnapshots.lastSeqId,
          ),
          isNotNull(currentToolRedactedSnapshot.terminalSeqId),
          sql`${currentToolRedactedSnapshot.objectKey}
            ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'`,
        ),
      )
      .where(
        and(
          gte(
            chatEventSnapshots.archiveSchemaVersion,
            CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
          ),
          lt(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
          isNull(currentToolRedactedSnapshot.id),
          chatThreadIds === null
            ? undefined
            : inArray(chatEventSnapshots.chatThreadId, chatThreadIds),
        ),
      ),
  ]);
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
    canonicalSnapshotHeads: canonicalRows[0]?.heads ?? 0,
    pendingCanonicalSnapshotMigrations: pendingRows[0]?.heads ?? 0,
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
            CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
          ),
          // V5 and V6 remain rollback and stale-client authorities throughout
          // Stage 3. Only versions below the advertised compatibility floor
          // may retire once V7 has equivalent physical coverage.
          exists(
            db
              .select({ id: currentToolRedactedSnapshot.id })
              .from(currentToolRedactedSnapshot)
              .where(
                and(
                  eq(
                    currentToolRedactedSnapshot.chatThreadId,
                    chatEventSnapshots.chatThreadId,
                  ),
                  eq(
                    currentToolRedactedSnapshot.archiveSchemaVersion,
                    CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                  ),
                  eq(currentToolRedactedSnapshot.projection, "tool-redacted"),
                  gte(
                    currentToolRedactedSnapshot.lastSeqId,
                    chatEventSnapshots.lastSeqId,
                  ),
                  sql`${currentToolRedactedSnapshot.objectKey}
                    ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'`,
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
            CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
          ),
          exists(
            db
              .select({ id: currentToolRedactedSnapshot.id })
              .from(currentToolRedactedSnapshot)
              .where(
                and(
                  eq(
                    currentToolRedactedSnapshot.chatThreadId,
                    chatEventSnapshots.chatThreadId,
                  ),
                  eq(
                    currentToolRedactedSnapshot.archiveSchemaVersion,
                    CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                  ),
                  eq(currentToolRedactedSnapshot.projection, "tool-redacted"),
                  gte(
                    currentToolRedactedSnapshot.lastSeqId,
                    chatEventSnapshots.lastSeqId,
                  ),
                  sql`${currentToolRedactedSnapshot.objectKey}
                    ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'`,
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
  const targetSeqId = sql`GREATEST(
    COALESCE(${chatEventSearchMessageWatermarks.indexedSeqId}, 0),
    COALESCE(${previousToolRedactedSnapshot.lastSeqId}, 0),
    COALESCE(${floorToolRedactedSnapshot.lastSeqId}, 0),
    COALESCE(${floorFullSnapshot.lastSeqId}, 0)
  )`.mapWith(chatThreads.lastChatEventSeqId);
  const rows = await db
    .select({
      chatThreadId: chatThreads.id,
      indexedSeqId: targetSeqId,
      headId: currentToolRedactedSnapshot.id,
      headLastSeqId: currentToolRedactedSnapshot.lastSeqId,
      headLastEventId: currentToolRedactedSnapshot.lastEventId,
      headTerminalSeqId: currentToolRedactedSnapshot.terminalSeqId,
      headTerminalEventId: currentToolRedactedSnapshot.terminalEventId,
      headObjectKey: currentToolRedactedSnapshot.objectKey,
      headArchiveSchemaVersion:
        currentToolRedactedSnapshot.archiveSchemaVersion,
    })
    .from(chatThreads)
    .leftJoin(
      chatEventSearchMessageWatermarks,
      eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
    )
    .leftJoin(
      currentToolRedactedSnapshot,
      and(
        eq(currentToolRedactedSnapshot.chatThreadId, chatThreads.id),
        eq(
          currentToolRedactedSnapshot.archiveSchemaVersion,
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        ),
        eq(
          currentToolRedactedSnapshot.projection,
          CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
        ),
      ),
    )
    .leftJoin(
      previousToolRedactedSnapshot,
      and(
        eq(previousToolRedactedSnapshot.chatThreadId, chatThreads.id),
        eq(
          previousToolRedactedSnapshot.archiveSchemaVersion,
          PREVIOUS_CHAT_EVENT_SCHEMA_VERSION,
        ),
        eq(
          previousToolRedactedSnapshot.projection,
          CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
        ),
      ),
    )
    .leftJoin(
      floorToolRedactedSnapshot,
      and(
        eq(floorToolRedactedSnapshot.chatThreadId, chatThreads.id),
        eq(
          floorToolRedactedSnapshot.archiveSchemaVersion,
          CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
        ),
        eq(
          floorToolRedactedSnapshot.projection,
          CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
        ),
      ),
    )
    .leftJoin(
      floorFullSnapshot,
      and(
        eq(floorFullSnapshot.chatThreadId, chatThreads.id),
        eq(
          floorFullSnapshot.archiveSchemaVersion,
          CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
        ),
        eq(floorFullSnapshot.projection, "full"),
      ),
    )
    .where(
      and(
        chatThreadIds === null
          ? undefined
          : inArray(chatThreads.id, chatThreadIds),
        or(
          isNotNull(chatEventSearchMessageWatermarks.chatThreadId),
          isNotNull(previousToolRedactedSnapshot.id),
          isNotNull(floorToolRedactedSnapshot.id),
          isNotNull(floorFullSnapshot.id),
        ),
        gt(targetSeqId, 0),
        or(
          isNull(currentToolRedactedSnapshot.id),
          lt(currentToolRedactedSnapshot.lastSeqId, targetSeqId),
          lte(currentToolRedactedSnapshot.lastSeqId, 0),
          isNull(currentToolRedactedSnapshot.terminalSeqId),
          sql`btrim(${currentToolRedactedSnapshot.objectKey}) = ''`,
          sql`NOT (${currentToolRedactedSnapshot.objectKey}
            ~ '-[0-9a-f]{64}[.]ndjson[.]gz$')`,
        ),
      ),
    )
    .orderBy(asc(chatThreads.lastMessageAt), asc(chatThreads.id))
    .limit(chatEventSnapshotThreadBatchSize());

  return rows.map((row): SnapshotCandidate => {
    return {
      chatThreadId: row.chatThreadId,
      indexedSeqId: row.indexedSeqId,
      projection: CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
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
 * refresh or schema upgrade must reuse a stored Snapshot prefix and append only
 * the Raw Event tail after its paired cursor. Missing objects and missing
 * migrations fail closed because older Raw Events may be reclaimed. Publication
 * uses an exact pointer CAS, so a lost race can only leave a collectable orphan
 * object.
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
    let skippedUnsupportedHeads = 0;
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
    const r2Gc = await set(
      collectR2SnapshotGarbage$,
      {
        db,
        bucket,
        options: {
          deleteQuota: SNAPSHOT_GC_DELETE_QUOTA - retiredSnapshots.selected,
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
