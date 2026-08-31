import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatGithubContext } from "@okouai/db/schema/chat-github-context";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { threadGoals } from "@okouai/db/schema/thread-goal";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  lt,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { STALE_QUEUE_ITEM_AGE_MS } from "./chat-thread-queue-drain.service";
import { chatEventTypeIn } from "./chat-event-type.service";

const ORPHANED_CHAT_EVENT_ERROR_CODE = "ORPHANED_QUEUED_CHAT_MESSAGES";
const monitoredEventRevoker = alias(chatEvents, "monitored_event_revoker");

class OrphanedQueuedChatEventsError extends Error {
  readonly code = ORPHANED_CHAT_EVENT_ERROR_CODE;

  constructor(
    readonly orphanedMessages: number,
    readonly orphanedMessagesBySource: Readonly<Record<string, number>>,
  ) {
    super("Orphaned queued chat messages detected");
    this.name = "OrphanedQueuedChatEventsError";
  }
}

function missingChatIntegrationContextRowCondition(db: Db) {
  return or(
    and(
      eq(chatEvents.contextType, "slack"),
      notExists(
        db
          .select({ id: chatSlackContext.id })
          .from(chatSlackContext)
          .where(
            and(
              eq(chatSlackContext.id, chatEvents.contextId),
              eq(chatSlackContext.chatThreadId, chatEvents.chatThreadId),
            ),
          ),
      ),
    ),
    and(
      eq(chatEvents.contextType, "feishu"),
      notExists(
        db
          .select({ id: chatFeishuContext.id })
          .from(chatFeishuContext)
          .where(
            and(
              eq(chatFeishuContext.id, chatEvents.contextId),
              eq(chatFeishuContext.chatThreadId, chatEvents.chatThreadId),
            ),
          ),
      ),
    ),
    and(
      eq(chatEvents.contextType, "teams"),
      notExists(
        db
          .select({ id: chatTeamsContext.id })
          .from(chatTeamsContext)
          .where(
            and(
              eq(chatTeamsContext.id, chatEvents.contextId),
              eq(chatTeamsContext.chatThreadId, chatEvents.chatThreadId),
            ),
          ),
      ),
    ),
    and(
      eq(chatEvents.contextType, "telegram"),
      notExists(
        db
          .select({ id: chatTelegramContext.id })
          .from(chatTelegramContext)
          .where(
            and(
              eq(chatTelegramContext.id, chatEvents.contextId),
              eq(chatTelegramContext.chatThreadId, chatEvents.chatThreadId),
            ),
          ),
      ),
    ),
    and(
      eq(chatEvents.contextType, "github"),
      notExists(
        db
          .select({ id: chatGithubContext.id })
          .from(chatGithubContext)
          .where(
            and(
              eq(chatGithubContext.id, chatEvents.contextId),
              eq(chatGithubContext.chatThreadId, chatEvents.chatThreadId),
            ),
          ),
      ),
    ),
  );
}

function missingScheduledContextRowCondition(db: Db) {
  return or(
    and(
      eq(chatEvents.contextType, "agentphone"),
      notExists(
        db
          .select({ id: chatAgentphoneContext.id })
          .from(chatAgentphoneContext)
          .where(
            and(
              eq(chatAgentphoneContext.id, chatEvents.contextId),
              eq(chatAgentphoneContext.chatThreadId, chatEvents.chatThreadId),
            ),
          ),
      ),
    ),
    and(
      eq(chatEvents.contextType, "automation"),
      notExists(
        db
          .select({ id: chatAutomationContext.id })
          .from(chatAutomationContext)
          .where(
            and(
              eq(chatAutomationContext.id, chatEvents.contextId),
              eq(chatAutomationContext.chatThreadId, chatEvents.chatThreadId),
            ),
          ),
      ),
    ),
  );
}

function missingGoalRowCondition(db: Db) {
  return and(
    chatEventTypeIn(["input.goal"]),
    notExists(
      db
        .select({ id: threadGoals.id })
        .from(threadGoals)
        .where(
          and(
            eq(chatEvents.contextType, "goal"),
            eq(threadGoals.id, chatEvents.contextId),
            eq(threadGoals.chatThreadId, chatEvents.chatThreadId),
          ),
        ),
    ),
  );
}

async function monitorChatEventQueue(
  db: Db,
  signal: AbortSignal,
  eventIds?: readonly string[],
) {
  const staleBefore = new Date(nowDate().getTime() - STALE_QUEUE_ITEM_AGE_MS);
  const orphanedSource = chatEvents.contextType;
  const results = await db
    .select({
      eventType: chatEvents.eventType,
      source: orphanedSource,
      orphanedMessages: count(),
    })
    .from(chatEvents)
    .where(
      and(
        eventIds === undefined
          ? undefined
          : inArray(chatEvents.id, [...eventIds]),
        chatEventTypeIn(["input.prompt", "input.automation", "input.goal"]),
        isNull(chatEvents.runId),
        notExists(
          db
            .select({ id: monitoredEventRevoker.id })
            .from(monitoredEventRevoker)
            .where(eq(monitoredEventRevoker.revokesEventId, chatEvents.id)),
        ),
        lt(chatEvents.createdAt, staleBefore),
        or(
          missingChatIntegrationContextRowCondition(db),
          missingScheduledContextRowCondition(db),
          missingGoalRowCondition(db),
        ),
      ),
    )
    .groupBy(orphanedSource, chatEvents.eventType);
  signal.throwIfAborted();

  const orphanedMessagesBySource: Record<string, number> = {};
  for (const result of results) {
    const source =
      result.eventType === "input.goal"
        ? "goal"
        : (result.source ?? "(unknown)");
    orphanedMessagesBySource[source] =
      (orphanedMessagesBySource[source] ?? 0) + result.orphanedMessages;
  }
  const orphanedMessages = Object.values(orphanedMessagesBySource).reduce(
    (total, sourceCount) => {
      return total + sourceCount;
    },
    0,
  );
  if (orphanedMessages > 0) {
    throw new OrphanedQueuedChatEventsError(
      orphanedMessages,
      orphanedMessagesBySource,
    );
  }

  return {
    success: true as const,
    orphanedMessages,
  };
}

export const monitorChatEventQueue$ = command(
  async ({ set }, signal: AbortSignal) => {
    return await monitorChatEventQueue(set(writeDb$), signal);
  },
);

export const monitorChatEventQueueForEvents$ = command(
  async ({ set }, eventIds: readonly string[], signal: AbortSignal) => {
    return await monitorChatEventQueue(set(writeDb$), signal, eventIds);
  },
);
