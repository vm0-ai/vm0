import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
} from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { visibleChatMessageCondition } from "./zero-chat-message-shared.service";

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
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
          isNotNull(chatMessages.content),
          isNull(chatMessages.error),
          visibleChatMessageCondition(),
          notExists(
            db
              .select({ id: chatMessageQueue.id })
              .from(chatMessageQueue)
              .where(eq(chatMessageQueue.chatMessageId, chatMessages.id)),
          ),
          notExists(
            db
              .select({ id: zeroRuns.id })
              .from(zeroRuns)
              .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
              .where(
                and(
                  eq(zeroRuns.chatThreadId, chatMessages.chatThreadId),
                  inArray(agentRuns.status, ["queued", "pending", "running"]),
                ),
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
