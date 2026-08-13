import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command, computed, type Computed } from "ccstate";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { env } from "../../lib/env";
import { db$, type ReadonlyDb } from "../external/db";
import {
  downloadS3Buffer,
  generatePresignedGetUrl,
  putImmutableS3Object,
} from "../external/s3";
import {
  downgradeChatEventSnapshotBody,
  downgradeChatEventRow,
} from "./chat-event-row-downgrade.service";
import {
  chatEventRowFromDbRow,
  migrateCurrentChatEventSnapshot$,
} from "./cron-snapshot-chat-events.service";

const SNAPSHOT_URL_TTL_SECONDS = 900;
const SNAPSHOT_CONTENT_TYPE = "application/x-ndjson";
const SNAPSHOT_CONTENT_ENCODING = "gzip";
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
/** Cursor that reads a thread from its very first event. */
const THREAD_START_SEQ_ID = 0;

type ChatEventSnapshotDownload =
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "snapshot-not-found" }
  | {
      readonly kind: "ok";
      readonly url: string;
      readonly expiresInSeconds: number;
      readonly lastEventId: string;
      readonly lastSeqId: number;
    };

type ChatEventRowsPage =
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "expired" }
  | { readonly kind: "ok"; readonly rows: readonly ChatEventRow[] };

const ownedThread = (threadId: string, userId: string) => {
  return and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId));
};

interface SnapshotPointer {
  readonly objectKey: string;
  readonly lastEventId: string;
  readonly lastSeqId: number;
  readonly schemaVersion: number;
}

async function snapshotPointer(
  db: ReadonlyDb,
  threadId: string,
  schemaVersion: number,
): Promise<SnapshotPointer | null> {
  const [pointer] = await db
    .select({
      objectKey: chatEventSnapshots.objectKey,
      lastEventId: chatEventSnapshots.lastEventId,
      lastSeqId: chatEventSnapshots.lastSeqId,
      schemaVersion: chatEventSnapshots.archiveSchemaVersion,
    })
    .from(chatEventSnapshots)
    .where(
      and(
        eq(chatEventSnapshots.chatThreadId, threadId),
        eq(chatEventSnapshots.archiveSchemaVersion, schemaVersion),
      ),
    )
    .limit(1);
  return pointer ?? null;
}

function snapshotObjectKey(
  threadId: string,
  lastSeqId: number,
  compressed: Buffer,
): string {
  const digest = createHash("sha256").update(compressed).digest("hex");
  return `chat-events/${threadId}/${lastSeqId.toString()}-${digest}.ndjson.gz`;
}

/**
 * Resolve the requested Snapshot version. Current-version upgrades persist a
 * new pointer; older versions are generated transiently from the current
 * immutable object and never create an older database row.
 */
export function zeroChatThreadEventSnapshot(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly schemaVersion: number;
}) {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<ChatEventSnapshotDownload> => {
      const db = get(db$);
      const [owned] = await db
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(ownedThread(args.threadId, args.userId))
        .limit(1);
      signal.throwIfAborted();
      if (!owned) {
        return { kind: "thread-not-found" } as const;
      }

      signal.throwIfAborted();
      let pointer = await snapshotPointer(
        db,
        args.threadId,
        CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      );
      signal.throwIfAborted();
      if (
        pointer === null &&
        args.schemaVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION
      ) {
        const migrated = await set(
          migrateCurrentChatEventSnapshot$,
          args.threadId,
          signal,
        );
        if (migrated) {
          pointer = await snapshotPointer(
            db,
            args.threadId,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          );
          signal.throwIfAborted();
        }
      }

      if (
        pointer === null &&
        args.schemaVersion < CURRENT_CHAT_EVENT_SCHEMA_VERSION
      ) {
        pointer = await snapshotPointer(db, args.threadId, args.schemaVersion);
        signal.throwIfAborted();
      }
      if (pointer === null) {
        return { kind: "snapshot-not-found" };
      }

      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      let objectKey = pointer.objectKey;
      if (pointer.schemaVersion > args.schemaVersion) {
        const compressed = await get(
          downloadS3Buffer(bucket, pointer.objectKey),
        );
        signal.throwIfAborted();
        const body = await gunzipAsync(compressed);
        signal.throwIfAborted();
        const downgraded = downgradeChatEventSnapshotBody(
          body,
          pointer.schemaVersion,
          args.schemaVersion,
        );
        const downgradedCompressed = await gzipAsync(downgraded);
        signal.throwIfAborted();
        objectKey = snapshotObjectKey(
          args.threadId,
          pointer.lastSeqId,
          downgradedCompressed,
        );
        await get(
          putImmutableS3Object(
            bucket,
            objectKey,
            downgradedCompressed,
            SNAPSHOT_CONTENT_TYPE,
            { signal, contentEncoding: SNAPSHOT_CONTENT_ENCODING },
          ),
        );
        signal.throwIfAborted();
      }

      const url = await get(
        generatePresignedGetUrl(bucket, objectKey, SNAPSHOT_URL_TTL_SECONDS),
      );
      signal.throwIfAborted();
      return {
        kind: "ok",
        url,
        expiresInSeconds: SNAPSHOT_URL_TTL_SECONDS,
        lastEventId: pointer.lastEventId,
        lastSeqId: pointer.lastSeqId,
      };
    },
  );
}

/**
 * Raw-row tail after a seq cursor. The cursor must still exist: a missing row
 * means the range below it is unavailable and the client has to rebuild from
 * a fresh snapshot. A cursor equal to the current head's last_seq_id is always
 * valid because the snapshot endpoint just handed it out. `sinceSeqId: 0` is
 * the cold start for a thread the archiver has not reached yet: it precedes
 * every event, so it owns no row of its own, and it stays valid only while the
 * thread has no current head.
 */
export function zeroChatThreadEventRows(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly schemaVersion: number;
  readonly sinceSeqId: number;
  readonly sinceEventId: string | undefined;
  readonly limit: number;
}): Computed<Promise<ChatEventRowsPage>> {
  return computed(async (get) => {
    const db = get(db$);
    const [owned] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(ownedThread(args.threadId, args.userId))
      .limit(1);
    if (!owned) {
      return { kind: "thread-not-found" } as const;
    }

    const [cursor] = await db
      .select({ id: chatEvents.id, seqId: chatEvents.seqId })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, args.threadId),
          eq(chatEvents.seqId, args.sinceSeqId),
        ),
      )
      .limit(1);
    if (
      cursor !== undefined &&
      args.sinceEventId !== undefined &&
      cursor.id !== args.sinceEventId
    ) {
      return { kind: "expired" } as const;
    }
    if (!cursor) {
      const [[storedSnapshot], [matchingSnapshotCursor]] = await Promise.all([
        db
          .select({ id: chatEventSnapshots.id })
          .from(chatEventSnapshots)
          .where(eq(chatEventSnapshots.chatThreadId, args.threadId))
          .limit(1),
        db
          .select({ id: chatEventSnapshots.id })
          .from(chatEventSnapshots)
          .where(
            and(
              eq(chatEventSnapshots.chatThreadId, args.threadId),
              or(
                eq(
                  chatEventSnapshots.archiveSchemaVersion,
                  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                ),
                eq(chatEventSnapshots.archiveSchemaVersion, args.schemaVersion),
              ),
              eq(chatEventSnapshots.lastSeqId, args.sinceSeqId),
              args.sinceEventId === undefined
                ? undefined
                : eq(chatEventSnapshots.lastEventId, args.sinceEventId),
            ),
          )
          .limit(1),
      ]);
      // The cold-start cursor precedes every event, so it owns no row. It is
      // only valid while nothing has ever been archived; once any Snapshot
      // exists the client must start from a Snapshot cursor instead.
      const coldStart =
        args.sinceSeqId === THREAD_START_SEQ_ID &&
        args.sinceEventId === undefined &&
        storedSnapshot === undefined;
      if (!coldStart && matchingSnapshotCursor === undefined) {
        return { kind: "expired" } as const;
      }
    }

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
          eq(chatEvents.chatThreadId, args.threadId),
          gt(chatEvents.seqId, args.sinceSeqId),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(args.limit);

    return {
      kind: "ok",
      rows: rows.map((row) => {
        return downgradeChatEventRow(
          chatEventRowFromDbRow(row),
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          args.schemaVersion,
        );
      }),
    } as const;
  });
}
