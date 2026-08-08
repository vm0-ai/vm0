import type { ChatEventRow } from "@vm0/api-contracts/contracts/chat-event-rows";
import { computed, type Computed } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatEventSnapshots } from "@vm0/db/schema/chat-event-snapshot";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import {
  ARCHIVE_SCHEMA_VERSION,
  chatEventRowFromDbRow,
} from "./cron-snapshot-chat-events.service";

const SNAPSHOT_URL_TTL_SECONDS = 900;

type ChatEventSnapshotDownload =
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "snapshot-not-found" }
  | {
      readonly kind: "ok";
      readonly url: string;
      readonly expiresInSeconds: number;
      readonly lastSeqId: number;
    };

type ChatEventRowsPage =
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "expired" }
  | { readonly kind: "ok"; readonly rows: readonly ChatEventRow[] };

const ownedThread = (threadId: string, userId: string) => {
  return and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId));
};

function currentHeadFilter(threadId: string) {
  return and(
    eq(chatEventSnapshots.chatThreadId, threadId),
    eq(chatEventSnapshots.isHead, true),
    eq(chatEventSnapshots.archiveSchemaVersion, ARCHIVE_SCHEMA_VERSION),
  );
}

/**
 * Presigned download for the thread's head archive object. Only heads on the
 * current archive schema version are served: older heads behave as missing
 * until the snapshot cron rewrites them, which the switch-gated client treats
 * the same as a thread without a snapshot.
 */
export function zeroChatThreadEventSnapshot(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<ChatEventSnapshotDownload>> {
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

    const [head] = await db
      .select({
        objectKey: chatEventSnapshots.objectKey,
        lastSeqId: chatEventSnapshots.lastSeqId,
      })
      .from(chatEventSnapshots)
      .where(currentHeadFilter(args.threadId))
      .limit(1);
    if (!head) {
      return { kind: "snapshot-not-found" } as const;
    }

    const url = await get(
      generatePresignedGetUrl(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        head.objectKey,
        SNAPSHOT_URL_TTL_SECONDS,
      ),
    );
    return {
      kind: "ok",
      url,
      expiresInSeconds: SNAPSHOT_URL_TTL_SECONDS,
      lastSeqId: head.lastSeqId,
    } as const;
  });
}

/**
 * Raw-row tail after a seq cursor. The cursor must still exist: a missing row
 * means the range below it was reclaimed and the client has to rebuild from a
 * fresh snapshot. A cursor equal to the current head's last_seq_id is always
 * valid because the snapshot endpoint just handed it out, even after the row
 * itself is eventually reclaimed.
 */
export function zeroChatThreadEventRows(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly sinceSeqId: number;
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
      .select({ seqId: chatEvents.seqId })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, args.threadId),
          eq(chatEvents.seqId, args.sinceSeqId),
        ),
      )
      .limit(1);
    if (!cursor) {
      const [head] = await db
        .select({ lastSeqId: chatEventSnapshots.lastSeqId })
        .from(chatEventSnapshots)
        .where(currentHeadFilter(args.threadId))
        .limit(1);
      if (head?.lastSeqId !== args.sinceSeqId) {
        return { kind: "expired" } as const;
      }
    }

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
          eq(chatEvents.chatThreadId, args.threadId),
          gt(chatEvents.seqId, args.sinceSeqId),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(args.limit);

    return { kind: "ok", rows: rows.map(chatEventRowFromDbRow) } as const;
  });
}
