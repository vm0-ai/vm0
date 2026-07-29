import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "../external/db";
import { nowDate } from "../external/time";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import {
  CANCELLATION_FINALIZATION_FINALIZED,
  CANCELLATION_FINALIZATION_STALE_MS,
} from "./runner-cancellation-finalization.service";

const ACTIVE_CHAT_RUN_STATUSES = ["queued", "pending", "running"] as const;

async function activeChatRunExists(
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
        or(
          and(
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
          and(
            eq(agentRuns.status, "cancelled"),
            isNotNull(agentRuns.cancellationFinalizationStatus),
            gt(
              agentRuns.completedAt,
              new Date(
                nowDate().getTime() - CANCELLATION_FINALIZATION_STALE_MS,
              ),
            ),
            or(
              ne(
                agentRuns.cancellationFinalizationStatus,
                CANCELLATION_FINALIZATION_FINALIZED,
              ),
              notExists(
                db
                  .select({ id: chatMessages.id })
                  .from(chatMessages)
                  .where(
                    and(
                      eq(chatMessages.runId, zeroRuns.id),
                      eq(chatMessages.runLifecycleEvent, "cancelled"),
                    ),
                  ),
              ),
            ),
          ),
        ),
      ),
    )
    .limit(1);

  return run !== undefined;
}

// A managed browser outlives the run that opened it and the next run simply
// attaches to the same live instance, so it must not hold up the thread's next
// run.
export async function chatThreadAdmissionBlocked(
  db: Pick<Db, "select">,
  args: {
    readonly threadId: string;
    readonly excludeRunId?: string;
  },
): Promise<boolean> {
  return await activeChatRunExists(db, args);
}
