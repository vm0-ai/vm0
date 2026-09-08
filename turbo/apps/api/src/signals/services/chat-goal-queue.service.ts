import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  lockChatQueueThread,
  pendingChatQueueEventCondition,
} from "./chat-event-queue.service";
import { revokeChatEvent } from "./chat-event.service";
import { lockGoalThread } from "./goal-lock.service";

/**
 * Settle old unclaimed inputs without granting Goal authority. Keep the existing
 * Goal -> thread lock order and canonical revoker, including on retry. Remove
 * this compatibility drain only after the #32653 global pending-input gate.
 */
export async function revokePendingGoalQueueEvents(
  db: Db,
  chatThreadId: string,
): Promise<number> {
  return await db.transaction(async (tx) => {
    await lockGoalThread(tx, chatThreadId);
    if (!(await lockChatQueueThread(tx, chatThreadId))) {
      return 0;
    }
    const events = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, chatThreadId),
          eq(chatEvents.eventType, "input.goal"),
          pendingChatQueueEventCondition(tx),
        ),
      );
    let revoked = 0;
    for (const event of events) {
      if (
        await revokeChatEvent(tx, event.id, {
          chatThreadId,
          eventType: "control.revoke",
          runId: null,
        })
      ) {
        revoked++;
      }
    }
    return revoked;
  });
}
