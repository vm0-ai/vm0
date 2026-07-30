import { chatEvents } from "@vm0/db/schema/chat-event";
import { command } from "ccstate";
import { and, count, inArray, isNull, or } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { visibleChatEventCondition } from "./zero-chat-event-shared.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

const ORPHANED_CHAT_EVENT_ERROR_CODE = "ORPHANED_QUEUED_CHAT_MESSAGES";

class OrphanedQueuedChatEventsError extends Error {
  readonly code = ORPHANED_CHAT_EVENT_ERROR_CODE;

  constructor(readonly orphanedMessages: number) {
    super("Orphaned queued chat messages detected");
    this.name = "OrphanedQueuedChatMessagesError";
  }
}

export const monitorChatEventQueue$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [result] = await db
      .select({ orphanedMessages: count() })
      .from(chatEvents)
      .where(
        and(
          isNull(chatEvents.runId),
          visibleChatEventCondition(db),
          or(
            and(
              chatEventTypeIn(["input.automation"]),
              or(
                isNull(chatEvents.automationId),
                isNull(chatEvents.triggerSource),
                isNull(chatEvents.encryptedParams),
              ),
            ),
            and(
              chatEventTypeIn(["input.prompt"]),
              inArray(chatEvents.triggerSource, [
                "slack",
                "feishu",
                "teams",
                "telegram",
              ]),
              isNull(chatEvents.encryptedParams),
            ),
          ),
        ),
      );
    signal.throwIfAborted();

    const orphanedMessages = result?.orphanedMessages ?? 0;
    if (orphanedMessages > 0) {
      throw new OrphanedQueuedChatEventsError(orphanedMessages);
    }

    return {
      success: true as const,
      orphanedMessages,
    };
  },
);
