import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command, computed, type Computed } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { env } from "../../lib/env";
import { db$, type ReadonlyDb } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import {
  chatEventRowFromDbRow,
  migrateCurrentChatEventSnapshot$,
} from "./cron-snapshot-chat-events.service";

const SNAPSHOT_URL_TTL_SECONDS = 900;
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

interface ChatEventRowsBaseArgs {
  readonly threadId: string;
  readonly userId: string;
  readonly limit: number;
}

type ChatEventRowsArgs = ChatEventRowsBaseArgs &
  (
    | { readonly sinceSeqId: 0; readonly sinceEventId?: never }
    | { readonly sinceSeqId: number; readonly sinceEventId: string }
  );

const ownedThread = (threadId: string, userId: string) => {
  return and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId));
};

interface SnapshotPointer {
  readonly objectKey: string;
  readonly lastEventId: string;
  readonly lastSeqId: number;
}

async function snapshotPointer(
  db: ReadonlyDb,
  threadId: string,
): Promise<SnapshotPointer | null> {
  const [pointer] = await db
    .select({
      objectKey: chatEventSnapshots.objectKey,
      lastEventId: chatEventSnapshots.lastEventId,
      lastSeqId: chatEventSnapshots.lastSeqId,
    })
    .from(chatEventSnapshots)
    .where(
      and(
        eq(chatEventSnapshots.chatThreadId, threadId),
        eq(
          chatEventSnapshots.archiveSchemaVersion,
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        ),
      ),
    )
    .limit(1);
  return pointer ?? null;
}

async function validSnapshotCursor(
  db: ReadonlyDb,
  args: ChatEventRowsArgs,
): Promise<boolean> {
  const [[storedSnapshot], [matchingSnapshotCursor]] = await Promise.all([
    db
      .select({ id: chatEventSnapshots.id })
      .from(chatEventSnapshots)
      .where(eq(chatEventSnapshots.chatThreadId, args.threadId))
      .limit(1),
    db
      .select({ lastEventId: chatEventSnapshots.lastEventId })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, args.threadId),
          eq(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
          eq(chatEventSnapshots.lastSeqId, args.sinceSeqId),
        ),
      )
      .limit(1),
  ]);
  // The cold-start cursor precedes every event, so it owns no row. It is
  // valid only while nothing has ever been archived; once any Snapshot exists
  // the client must start from that Snapshot's paired cursor.
  if (args.sinceSeqId === THREAD_START_SEQ_ID && storedSnapshot === undefined) {
    return true;
  }
  return matchingSnapshotCursor?.lastEventId === args.sinceEventId;
}

/** Resolve the current persisted Snapshot pointer. */
export function chatThreadEventSnapshot(args: {
  readonly threadId: string;
  readonly userId: string;
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

      let pointer = await snapshotPointer(db, args.threadId);
      signal.throwIfAborted();
      if (pointer === null) {
        const migrated = await set(
          migrateCurrentChatEventSnapshot$,
          args.threadId,
          signal,
        );
        if (migrated) {
          pointer = await snapshotPointer(db, args.threadId);
          signal.throwIfAborted();
        }
      }
      if (pointer === null) {
        return { kind: "snapshot-not-found" };
      }

      const url = await get(
        generatePresignedGetUrl(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          pointer.objectKey,
          SNAPSHOT_URL_TTL_SECONDS,
        ),
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
 * Raw-row tail after a paired cursor. A missing cursor row means the range
 * below it is unavailable and the client has to rebuild from a fresh
 * Snapshot. `sinceSeqId: 0` remains the cold start for a thread that has never
 * had a Snapshot.
 */
export function chatThreadEventRows(
  args: ChatEventRowsArgs,
): Computed<Promise<ChatEventRowsPage>> {
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
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, args.threadId),
          eq(chatEvents.seqId, args.sinceSeqId),
        ),
      )
      .limit(1);
    const validCursor =
      cursor === undefined
        ? await validSnapshotCursor(db, args)
        : cursor.id === args.sinceEventId;
    if (!validCursor) {
      return { kind: "expired" } as const;
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
      rows: rows.map(chatEventRowFromDbRow),
    } as const;
  });
}
