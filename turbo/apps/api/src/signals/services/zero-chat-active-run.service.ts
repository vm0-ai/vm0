import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "../external/db";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

const ACTIVE_CHAT_RUN_STATUSES = ["queued", "pending", "running"] as const;

export async function activeChatRunExists(
  db: Pick<Db, "select">,
  args: {
    readonly threadId: string;
    readonly excludeRunId?: string;
  },
): Promise<boolean> {
  const [run] = await db
    .select({ id: zeroRuns.id })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, args.threadId),
        args.excludeRunId === undefined
          ? undefined
          : ne(zeroRuns.id, args.excludeRunId),
        inArray(agentRuns.status, ACTIVE_CHAT_RUN_STATUSES),
        or(
          notExists(
            db
              .select({ id: agentRunCallbacks.id })
              .from(agentRunCallbacks)
              .where(
                and(
                  eq(agentRunCallbacks.runId, zeroRuns.id),
                  eq(agentRunCallbacks.internalKind, "chat"),
                  isNotNull(
                    sql`${agentRunCallbacks.payload}->>'queuedMessageId'`,
                  ),
                ),
              ),
          ),
          exists(
            db
              .select({ id: chatMessages.id })
              .from(chatMessages)
              .where(
                and(
                  eq(chatMessages.runId, zeroRuns.id),
                  chatEventTypeIn(["input.prompt"]),
                ),
              ),
          ),
        ),
      ),
    )
    .limit(1);

  return run !== undefined;
}
