import { and, desc, eq, sql } from "drizzle-orm";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@vm0/db/schema/chat-event";
import type { chatThreads } from "@vm0/db/schema/chat-thread";

import type { Db } from "../external/db";

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
        chatEventTerminalPredicate(chatEvents.eventType),
      ),
    )
    .orderBy(sql`${desc(chatEvents.createdAt)} NULLS LAST`, desc(chatEvents.id))
    .limit(1)
    .as("latest_run_finish_message");
}
