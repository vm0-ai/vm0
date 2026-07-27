import { and, desc, eq } from "drizzle-orm";
import { chatMessages } from "@vm0/db/schema/chat-message";
import type { chatThreads } from "@vm0/db/schema/chat-thread";

import type { Db } from "../external/db";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

export function latestRunFinishMessageSubquery(
  db: Pick<Db, "select">,
  threadId: string | typeof chatThreads.id,
) {
  return db
    .select({
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        chatEventTypeIn(["run.completed", "run.failed", "run.cancelled"]),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1)
    .as("latest_run_finish_message");
}
