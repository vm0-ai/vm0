import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
  CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { computed, type Computed } from "ccstate";
import { and, asc, desc, eq, gt, gte, lte } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";

import type { Db } from "../external/db";
import { downloadS3Buffer } from "../external/s3";
import { decodeChatEventSnapshotBody } from "./chat-event-snapshot-body.service";
import { chatEventRowFromDbRow } from "./cron-snapshot-chat-events.service";
import {
  lastStoredChatEventSnapshotRowId,
  upgradeChatEventSnapshotBody,
} from "./chat-event-snapshot-upgrade.service";

const gunzipAsync = promisify(gunzip);
const CHAT_EVENT_HISTORY_PAGE_SIZE = 1000;

interface ChatEventHistoryRuntime {
  readonly db: Db;
  readonly bucket: string;
}

type ChatEventHistoryQueryDb = Pick<Db, "select">;

async function readPostgresTail(
  db: ChatEventHistoryQueryDb,
  chatThreadId: string,
  afterSeqId: number,
  signal: AbortSignal,
): Promise<readonly ChatEventRow[]> {
  const events: ChatEventRow[] = [];
  let cursor = afterSeqId;
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
          eq(chatEvents.chatThreadId, chatThreadId),
          gt(chatEvents.seqId, cursor),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(CHAT_EVENT_HISTORY_PAGE_SIZE);
    signal.throwIfAborted();
    events.push(...rows.map(chatEventRowFromDbRow));
    const lastRow = rows[rows.length - 1];
    if (lastRow !== undefined) {
      cursor = lastRow.seqId;
    }
    if (rows.length < CHAT_EVENT_HISTORY_PAGE_SIZE) {
      return events;
    }
  }
}

function decodeSnapshotRows(
  body: Buffer,
  chatThreadId: string,
  lastSeqId: number,
  terminalCursor: {
    readonly eventId: string | null;
    readonly seqId: number | null;
  },
): readonly ChatEventRow[] {
  const rows = decodeChatEventSnapshotBody(body);
  let previousSeqId: number | null = null;
  for (const row of rows) {
    if (
      row.chatThreadId !== chatThreadId ||
      (previousSeqId !== null && row.seqId <= previousSeqId) ||
      row.seqId > lastSeqId
    ) {
      throw new Error("Chat event snapshot ordering metadata is invalid");
    }
    previousSeqId = row.seqId;
  }
  if (
    terminalCursor.seqId !== null &&
    ((rows.at(-1)?.id ?? null) !== terminalCursor.eventId ||
      (rows.at(-1)?.seqId ?? 0) !== terminalCursor.seqId)
  ) {
    throw new Error("Chat event snapshot terminal metadata is invalid");
  }
  return rows;
}

function snapshotObjectDigest(objectKey: string): string {
  const digest = /-([0-9a-f]{64})\.ndjson\.gz$/u.exec(objectKey)?.[1];
  if (digest === undefined) {
    throw new Error("Chat event snapshot object key is invalid");
  }
  return digest;
}

function readCurrentChatEventHistoryAtSnapshot(
  runtime: Omit<ChatEventHistoryRuntime, "db"> & {
    readonly db: ChatEventHistoryQueryDb;
  },
  chatThreadId: string,
  signal: AbortSignal,
): Computed<Promise<readonly ChatEventRow[]>> {
  return computed(async (get) => {
    const [head] = await runtime.db
      .select({
        archiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
        lastSeqId: chatEventSnapshots.lastSeqId,
        lastEventId: chatEventSnapshots.lastEventId,
        terminalSeqId: chatEventSnapshots.terminalSeqId,
        terminalEventId: chatEventSnapshots.terminalEventId,
        sourceProjection: chatEventSnapshots.projection,
        objectKey: chatEventSnapshots.objectKey,
      })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, chatThreadId),
          gte(
            chatEventSnapshots.archiveSchemaVersion,
            CHAT_EVENT_SCHEMA_DOWNGRADE_FLOOR,
          ),
          lte(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
        ),
      )
      .orderBy(
        // During rolling publication, the physically furthest compatible
        // prefix is authoritative; V7 wins once it reaches equal coverage.
        desc(chatEventSnapshots.lastSeqId),
        desc(chatEventSnapshots.archiveSchemaVersion),
        desc(
          eq(
            chatEventSnapshots.projection,
            CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (head === undefined) {
      return await readPostgresTail(runtime.db, chatThreadId, 0, signal);
    }
    if (head.lastSeqId <= 0 || head.objectKey.trim().length === 0) {
      throw new Error("Chat event snapshot head is not reusable");
    }

    const compressed = await get(
      downloadS3Buffer(runtime.bucket, head.objectKey),
    );
    signal.throwIfAborted();
    if (
      createHash("sha256").update(compressed).digest("hex") !==
      snapshotObjectDigest(head.objectKey)
    ) {
      throw new Error("Chat event snapshot checksum is invalid");
    }
    const decompressed = await gunzipAsync(compressed);
    if (
      head.sourceProjection === "full" &&
      lastStoredChatEventSnapshotRowId(
        decompressed,
        head.archiveSchemaVersion,
      ) !== head.lastEventId
    ) {
      throw new Error("Chat event snapshot physical metadata is invalid");
    }
    const snapshot = decodeSnapshotRows(
      upgradeChatEventSnapshotBody(
        decompressed,
        head.archiveSchemaVersion,
        CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      ),
      chatThreadId,
      head.lastSeqId,
      {
        eventId: head.terminalEventId,
        seqId: head.terminalSeqId,
      },
    );
    signal.throwIfAborted();
    const tail = await readPostgresTail(
      runtime.db,
      chatThreadId,
      head.lastSeqId,
      signal,
    );
    return [...snapshot, ...tail];
  });
}

/**
 * Current logical thread history: prefer the canonical V7 R2 pointer and fall
 * back to a still-referenced, upgradable V5/V6 prefix under #29362's storage
 * gates. PostgreSQL continuation begins after the pointer's physical coverage.
 */
export function readCurrentChatEventHistory(
  runtime: ChatEventHistoryRuntime,
  chatThreadId: string,
  signal: AbortSignal,
): Computed<Promise<readonly ChatEventRow[]>> {
  return computed(async (get) => {
    return await runtime.db.transaction(
      async (tx) => {
        return await get(
          readCurrentChatEventHistoryAtSnapshot(
            { ...runtime, db: tx },
            chatThreadId,
            signal,
          ),
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  });
}
