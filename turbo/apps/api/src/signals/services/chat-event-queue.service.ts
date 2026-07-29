import {
  foldChatAutomationIntakePause,
  foldPendingChatQueueEvents,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

type ChatQueueReadDb = Pick<Db, "select">;
type ChatQueueDistinctReadDb = Pick<Db, "select" | "selectDistinct">;

const queueEventRevoker = alias(chatMessages, "queue_event_revoker");
const automationPauseEvent = alias(chatMessages, "automation_pause_event");
const laterAutomationPauseEvent = alias(
  chatMessages,
  "later_automation_pause_event",
);

interface PendingChatQueueEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: "input.prompt" | "input.automation";
  readonly createdAt: Date;
}

interface ChatAutomationIntakePause {
  readonly pausedAt: Date;
  readonly pauseReason: string | null;
}

function unrevokedQueueEventCondition(db: ChatQueueReadDb) {
  return notExists(
    db
      .select({ id: queueEventRevoker.id })
      .from(queueEventRevoker)
      .where(eq(queueEventRevoker.revokesEventId, chatMessages.id)),
  );
}

/**
 * Fold one thread's immutable input events into its pending queue. User input
 * keeps absolute priority over automation input, then each class is FIFO by
 * the original event timestamp and id.
 */
export async function listPendingChatQueueEvents(
  db: ChatQueueReadDb,
  chatThreadId: string,
  createdBefore?: Date,
): Promise<readonly PendingChatQueueEvent[]> {
  const rows = await db
    .select({
      id: chatMessages.id,
      chatThreadId: chatMessages.chatThreadId,
      eventType: chatMessages.eventType,
      runId: chatMessages.runId,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, chatThreadId),
        chatEventTypeIn(["input.prompt", "input.automation"]),
        isNull(chatMessages.runId),
        createdBefore ? lt(chatMessages.createdAt, createdBefore) : undefined,
        unrevokedQueueEventCondition(db),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

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
      event.eventType !== "input.automation"
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
      id: chatMessages.id,
      chatThreadId: chatMessages.chatThreadId,
      eventType: chatMessages.eventType,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, args.eventId),
        eq(chatMessages.chatThreadId, args.chatThreadId),
        chatEventTypeIn(["input.prompt", "input.automation"]),
        isNull(chatMessages.runId),
        unrevokedQueueEventCondition(db),
      ),
    )
    .limit(1);
  if (
    !event ||
    (event.eventType !== "input.prompt" &&
      event.eventType !== "input.automation")
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
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, chatThreadId),
        chatEventTypeIn(["input.prompt"]),
        isNull(chatMessages.runId),
        unrevokedQueueEventCondition(db),
      ),
    )
    .limit(1);
  return event !== undefined;
}

/** Latest pause/resume leaf is the automation-intake circuit-breaker state. */
export async function loadChatAutomationIntakePause(
  db: ChatQueueReadDb,
  chatThreadId: string,
): Promise<ChatAutomationIntakePause | null> {
  const rows = await db
    .select({
      eventType: chatMessages.eventType,
      createdAt: chatMessages.createdAt,
      pauseReason: chatMessages.error,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, chatThreadId),
        chatEventTypeIn([
          "queue.automation_paused",
          "queue.automation_resumed",
        ]),
      ),
    )
    .orderBy(desc(chatMessages.seqId))
    .limit(1);
  const state = foldChatAutomationIntakePause(
    rows.map((row) => {
      return {
        eventType: row.eventType,
        createdAt: row.createdAt.toISOString(),
        pauseReason: row.pauseReason,
      };
    }),
  );
  return state
    ? {
        pausedAt: new Date(state.pausedAt),
        pauseReason: state.pauseReason,
      }
    : null;
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

function noCurrentAutomationPauseCondition(db: ChatQueueReadDb) {
  return notExists(
    db
      .select({ id: automationPauseEvent.id })
      .from(automationPauseEvent)
      .where(
        and(
          eq(automationPauseEvent.chatThreadId, chatMessages.chatThreadId),
          eq(
            automationPauseEvent.eventType,
            "queue.automation_paused" satisfies ChatEventType,
          ),
          notExists(
            db
              .select({ id: laterAutomationPauseEvent.id })
              .from(laterAutomationPauseEvent)
              .where(
                and(
                  eq(
                    laterAutomationPauseEvent.chatThreadId,
                    automationPauseEvent.chatThreadId,
                  ),
                  inArray(laterAutomationPauseEvent.eventType, [
                    "queue.automation_paused" satisfies ChatEventType,
                    "queue.automation_resumed" satisfies ChatEventType,
                  ]),
                  gt(
                    laterAutomationPauseEvent.seqId,
                    automationPauseEvent.seqId,
                  ),
                ),
              ),
          ),
        ),
      ),
  );
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
    .selectDistinct({ chatThreadId: chatMessages.chatThreadId })
    .from(chatMessages)
    .where(
      and(
        chatEventTypeIn(["input.prompt", "input.automation"]),
        isNull(chatMessages.runId),
        lt(chatMessages.createdAt, args.staleBefore),
        unrevokedQueueEventCondition(db),
        or(
          eq(chatMessages.eventType, "input.prompt" satisfies ChatEventType),
          and(
            eq(
              chatMessages.eventType,
              "input.automation" satisfies ChatEventType,
            ),
            noCurrentAutomationPauseCondition(db),
          ),
        ),
      ),
    )
    .limit(args.limit);
  return rows.map((row) => {
    return row.chatThreadId;
  });
}
