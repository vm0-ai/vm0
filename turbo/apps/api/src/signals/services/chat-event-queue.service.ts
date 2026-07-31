import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  and,
  asc,
  eq,
  isNull,
  lt,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
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

export function pendingChatQueueEventCondition(db: ChatQueueReadDb) {
  return and(
    chatEventTypeIn(["input.prompt", "input.automation", "input.goal"]),
    isNull(chatEvents.runId),
    unrevokedQueueEventCondition(db),
  );
}

function chatQueueEventPriority(): SQL {
  return sql`CASE ${chatEvents.eventType}
    WHEN 'input.prompt' THEN 0
    WHEN 'input.automation' THEN 1
    WHEN 'input.goal' THEN 2
    ELSE 3
  END`;
}

/** Complete database-native order shared by queue reads and atomic claims. */
export function chatQueueEventOrderBy(): readonly [SQL, SQL, SQL] {
  return [
    chatQueueEventPriority(),
    asc(chatEvents.createdAt),
    asc(chatEvents.id),
  ];
}

/**
 * Read one thread's immutable input events as its pending queue. User input
 * keeps absolute priority over automation input, automation stays ahead of
 * goal continuation, then each class is FIFO by the original event timestamp
 * and id. PostgreSQL must perform the ordering: JavaScript Date values discard
 * database microseconds, while the atomic claim compares the full timestamp.
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
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        pendingChatQueueEventCondition(db),
        createdBefore ? lt(chatEvents.createdAt, createdBefore) : undefined,
      ),
    )
    .orderBy(...chatQueueEventOrderBy());

  return rows.flatMap((event) => {
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
        createdAt: event.createdAt,
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
        pendingChatQueueEventCondition(db),
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
        pendingChatQueueEventCondition(db),
        chatEventTypeIn(["input.prompt"]),
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
        pendingChatQueueEventCondition(db),
        lt(chatEvents.createdAt, args.staleBefore),
      ),
    )
    .limit(args.limit);
  return rows.map((row) => {
    return row.chatThreadId;
  });
}
