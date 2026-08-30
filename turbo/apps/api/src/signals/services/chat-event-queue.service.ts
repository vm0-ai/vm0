import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import { chatEventTypeIn } from "./chat-event-type.service";

type ChatQueueReadDb = Pick<Db, "select">;
type ChatQueueDistinctReadDb = Pick<Db, "select" | "selectDistinct">;

const queueEventRevoker = alias(chatEvents, "queue_event_revoker");

interface PendingChatQueueEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: "input.prompt" | "input.automation" | "input.goal";
  readonly seqId: number;
  readonly createdAt: Date;
}

function unrevokedQueueEventCondition(db: ChatQueueReadDb) {
  return and(
    notExists(
      db
        .select({ id: queueEventRevoker.id })
        .from(queueEventRevoker)
        .where(eq(queueEventRevoker.revokesEventId, chatEvents.id)),
    ),
    notExists(
      db
        .select({ deliveryId: activeInputDeliveryItems.deliveryId })
        .from(activeInputDeliveryItems)
        .innerJoin(
          activeInputDeliveries,
          eq(activeInputDeliveries.id, activeInputDeliveryItems.deliveryId),
        )
        .where(
          and(
            eq(activeInputDeliveryItems.sourceEventId, chatEvents.id),
            isNull(activeInputDeliveryItems.disposition),
            eq(activeInputDeliveries.status, "open"),
          ),
        ),
    ),
  );
}

function pendingActiveInputPromptCondition(db: ChatQueueReadDb) {
  return and(
    chatEventTypeIn(["input.prompt"]),
    isNull(chatEvents.runId),
    sql`${chatEvents.contextType} IS DISTINCT FROM 'morning_brief'`,
    unrevokedQueueEventCondition(db),
  );
}

export function pendingActiveInputCondition(
  db: ChatQueueReadDb,
  runId: string,
) {
  return or(
    pendingActiveInputPromptCondition(db),
    and(
      chatEventTypeIn(["input.budget"]),
      isNull(chatEvents.runId),
      eq(chatEvents.contextType, "agent_run"),
      eq(chatEvents.contextId, runId),
      unrevokedQueueEventCondition(db),
    ),
  );
}

export function pendingChatQueueEventCondition(db: ChatQueueReadDb) {
  return and(
    chatEventTypeIn(["input.prompt", "input.automation", "input.goal"]),
    isNull(chatEvents.runId),
    unrevokedQueueEventCondition(db),
  );
}

export function chatQueueEventPriority(): SQL {
  return sql`CASE ${chatEvents.eventType}
    WHEN 'input.prompt' THEN 0
    WHEN 'input.automation' THEN 1
    WHEN 'input.goal' THEN 2
    ELSE 3
  END`;
}

/**
 * List one thread's pending queue in its authoritative database order. User
 * input keeps absolute priority over the rest; automation input stays ahead of
 * goal continuation, because a goal continues itself after every run and would
 * otherwise leave no idle window for an automation event to be claimed. Each
 * class is FIFO by the original event timestamp and id. Keep the sort in
 * PostgreSQL so sub-millisecond timestamp precision matches the final
 * queue-claim queries.
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
      seqId: chatEvents.seqId,
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
    .orderBy(
      chatQueueEventPriority(),
      asc(chatEvents.createdAt),
      asc(chatEvents.id),
    );

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
        seqId: event.seqId,
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
      seqId: chatEvents.seqId,
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
    readonly chatThreadIds?: readonly string[];
  },
): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ chatThreadId: chatEvents.chatThreadId })
    .from(chatEvents)
    .where(
      and(
        pendingChatQueueEventCondition(db),
        lt(chatEvents.createdAt, args.staleBefore),
        args.chatThreadIds === undefined
          ? undefined
          : inArray(chatEvents.chatThreadId, args.chatThreadIds),
      ),
    )
    .limit(args.limit);
  return rows.map((row) => {
    return row.chatThreadId;
  });
}
