import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
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

interface ChatEventRowsArgs {
  readonly threadId: string;
  readonly userId: string;
  readonly cursor: ChatEventCursor;
  readonly limit: number;
}

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

async function cursorMatchesSnapshotState(
  db: ReadonlyDb,
  args: ChatEventRowsArgs,
): Promise<boolean> {
  if (args.cursor.lastEventId === null) {
    const [storedSnapshot] = await db
      .select({ id: chatEventSnapshots.id })
      .from(chatEventSnapshots)
      .where(eq(chatEventSnapshots.chatThreadId, args.threadId))
      .limit(1);
    return storedSnapshot === undefined;
  }

  const [matchingSnapshotCursor] = await db
    .select({ id: chatEventSnapshots.id })
    .from(chatEventSnapshots)
    .where(
      and(
        eq(chatEventSnapshots.chatThreadId, args.threadId),
        eq(
          chatEventSnapshots.archiveSchemaVersion,
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        ),
        eq(chatEventSnapshots.lastSeqId, args.cursor.lastSeqId),
        eq(chatEventSnapshots.lastEventId, args.cursor.lastEventId),
      ),
    )
    .limit(1);
  return matchingSnapshotCursor !== undefined;
}

/** Resolve the current immutable Snapshot pointer for a thread. */
export function zeroChatThreadEventSnapshot(args: {
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
 * Raw-row tail after a paired cursor. A cursor equal to the current Snapshot
 * terminal position remains valid after its Raw Event has been reclaimed.
 * The sole cursor without an event identity is `{ lastSeqId: 0 }`, and it is
 * valid only while the thread has no Snapshot pointer.
 */
export function zeroChatThreadEventRows(
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
          eq(chatEvents.seqId, args.cursor.lastSeqId),
        ),
      )
      .limit(1);
    if (
      cursor !== undefined &&
      (args.cursor.lastEventId === null ||
        cursor.id !== args.cursor.lastEventId)
    ) {
      return { kind: "expired" } as const;
    }
    if (cursor === undefined && !(await cursorMatchesSnapshotState(db, args))) {
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
          gt(chatEvents.seqId, args.cursor.lastSeqId),
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
