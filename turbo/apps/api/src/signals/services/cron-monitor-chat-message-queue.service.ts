import { chatMessages } from "@vm0/db/schema/chat-message";
import { command } from "ccstate";
import { and, count, inArray, isNull, or } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { visibleChatEventCondition } from "./zero-chat-message-shared.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

const ORPHANED_CHAT_MESSAGE_ERROR_CODE = "ORPHANED_QUEUED_CHAT_MESSAGES";

class OrphanedQueuedChatMessagesError extends Error {
  readonly code = ORPHANED_CHAT_MESSAGE_ERROR_CODE;

  constructor(readonly orphanedMessages: number) {
    super("Orphaned queued chat messages detected");
    this.name = "OrphanedQueuedChatMessagesError";
  }
}

export const monitorChatMessageQueue$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [result] = await db
      .select({ orphanedMessages: count() })
      .from(chatMessages)
      .where(
        and(
          isNull(chatMessages.runId),
          visibleChatEventCondition(db),
          or(
            and(
              chatEventTypeIn(["input.automation"]),
              or(
                isNull(chatMessages.automationId),
                isNull(chatMessages.triggerSource),
                isNull(chatMessages.encryptedParams),
              ),
            ),
            and(
              chatEventTypeIn(["input.prompt"]),
              inArray(chatMessages.triggerSource, [
                "slack",
                "feishu",
                "teams",
                "telegram",
              ]),
              isNull(chatMessages.encryptedParams),
            ),
          ),
        ),
      );
    signal.throwIfAborted();

    const orphanedMessages = result?.orphanedMessages ?? 0;
    if (orphanedMessages > 0) {
      throw new OrphanedQueuedChatMessagesError(orphanedMessages);
    }

    return {
      success: true as const,
      orphanedMessages,
    };
  },
);
