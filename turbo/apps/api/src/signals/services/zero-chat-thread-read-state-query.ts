import { and, desc, eq, isNotNull } from "drizzle-orm";
import { chatMessages } from "@vm0/db/schema/chat-message";
import type { chatThreads } from "@vm0/db/schema/chat-thread";

import type { Db } from "../external/db";

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
        isNotNull(chatMessages.runLifecycleEvent),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1)
    .as("latest_run_finish_message");
}
