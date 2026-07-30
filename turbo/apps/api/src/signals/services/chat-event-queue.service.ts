import { foldPendingChatQueueEvents } from "@vm0/api-contracts/contracts/chat-events";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, asc, eq, isNull, lt, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

type ChatQueueReadDb = Pick<Db, "select">;
type ChatQueueDistinctReadDb = Pick<Db, "select" | "selectDistinct">;

const queueEventRevoker = alias(chatEvents, "queue_event_revoker");

interface PendingChatQueueEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: "input.prompt" | "input.automation" | "input.goal";
  readonly createdAt: Date;
}

function unrevokedQueueEventCondition(db: ChatQueueReadDb) {
  return notExists(
    db
      .select({ id: queueEventRevoker.id })
      .from(queueEventRevoker)
      .where(eq(queueEventRevoker.revokesEventId, chatEvents.id)),
  );
}

/**
 * Fold one thread's immutable input events into its pending queue. User input
 * keeps absolute priority over automation input, automation stays ahead of
 * goal continuation, then each class is FIFO by the original event timestamp
 * and id.
 */
export async function listPendingChatQueueEvents(
  db: ChatQueueReadDb,
  chatThreadId: string,
  createdBefore?: Date,
): Promise<readonly PendingChatQueueEvent[]> {
  const rows = await db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      eventType: chatEvents.eventType,
      runId: chatEvents.runId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        chatEventTypeIn(["input.prompt", "input.automation", "input.goal"]),
        isNull(chatEvents.runId),
        createdBefore ? lt(chatEvents.createdAt, createdBefore) : undefined,
        unrevokedQueueEventCondition(db),
      ),
    )
    .orderBy(asc(chatEvents.createdAt), asc(chatEvents.id));

  const folded = foldPendingChatQueueEvents(
    rows.map((row) => {
      return {
        ...row,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  );
  return folded.flatMap((event) => {
    if (
      event.eventType !== "input.prompt" &&
      event.eventType !== "input.automation" &&
      event.eventType !== "input.goal"
    ) {
      return [];
    }
    return [
      {
        id: event.id,
        chatThreadId: event.chatThreadId,
        eventType: event.eventType,
        createdAt: new Date(event.createdAt),
      },
    ];
  });
}

export async function loadPendingChatQueueEvent(
  db: ChatQueueReadDb,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
  },
): Promise<PendingChatQueueEvent | null> {
  const [event] = await db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      eventType: chatEvents.eventType,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        chatEventTypeIn(["input.prompt", "input.automation", "input.goal"]),
        isNull(chatEvents.runId),
        unrevokedQueueEventCondition(db),
      ),
    )
    .limit(1);
  if (
    !event ||
    (event.eventType !== "input.prompt" &&
      event.eventType !== "input.automation" &&
      event.eventType !== "input.goal")
  ) {
    return null;
  }
  return { ...event, eventType: event.eventType };
}

export async function hasPendingUserChatQueueEvent(
  db: ChatQueueReadDb,
  chatThreadId: string,
): Promise<boolean> {
  const [event] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        chatEventTypeIn(["input.prompt"]),
        isNull(chatEvents.runId),
        unrevokedQueueEventCondition(db),
      ),
    )
    .limit(1);
  return event !== undefined;
}

/** Shared row lock for every authoritative queue claim or revocation. */
export async function lockChatQueueThread(
  db: ChatQueueReadDb,
  chatThreadId: string,
): Promise<boolean> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .for("update");
  return thread !== undefined;
}

/** Threads with stale runnable event-backed queue work for the safety sweep. */
export async function staleChatEventQueueThreadIds(
  db: ChatQueueDistinctReadDb,
  args: {
    readonly staleBefore: Date;
    readonly limit: number;
  },
): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ chatThreadId: chatEvents.chatThreadId })
    .from(chatEvents)
    .where(
      and(
        chatEventTypeIn(["input.prompt", "input.automation", "input.goal"]),
        isNull(chatEvents.runId),
        lt(chatEvents.createdAt, args.staleBefore),
        unrevokedQueueEventCondition(db),
      ),
    )
    .limit(args.limit);
  return rows.map((row) => {
    return row.chatThreadId;
  });
}
