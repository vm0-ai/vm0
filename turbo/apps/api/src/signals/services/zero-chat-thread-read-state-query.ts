import { and, desc, eq } from "drizzle-orm";
import { chatEvents } from "@vm0/db/schema/chat-event";
import type { chatThreads } from "@vm0/db/schema/chat-thread";

import type { Db } from "../external/db";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

export function latestRunFinishEventSubquery(
  db: Pick<Db, "select">,
  threadId: string | typeof chatThreads.id,
) {
  return db
    .select({
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTypeIn(["run.completed", "run.failed", "run.cancelled"]),
      ),
    )
    .orderBy(desc(chatEvents.createdAt), desc(chatEvents.id))
    .limit(1)
    .as("latest_run_finish_message");
}
