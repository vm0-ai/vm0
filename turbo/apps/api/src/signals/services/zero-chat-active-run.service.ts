import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatEvents } from "@vm0/db/schema/chat-event";
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

const ACTIVE_CHAT_RUN_STATUSES = ["queued", "pending", "running"] as const;
const CANCELLATION_RECOVERY_STALE_AFTER_MS = 10 * 60 * 1000;

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
                  .select({ id: chatEvents.id })
                  .from(chatEvents)
                  .where(
                    and(
                      eq(chatEvents.runId, zeroRuns.id),
                      chatEventTypeIn(["input.prompt"]),
                    ),
                  ),
              ),
            ),
          ),
          and(
            eq(agentRuns.status, "cancelled"),
            isNotNull(agentRuns.cancellationRecoveryCompleted),
            gt(
              agentRuns.completedAt,
              new Date(
                nowDate().getTime() - CANCELLATION_RECOVERY_STALE_AFTER_MS,
              ),
            ),
            or(
              eq(agentRuns.cancellationRecoveryCompleted, false),
              notExists(
                db
                  .select({ id: chatEvents.id })
                  .from(chatEvents)
                  .where(
                    and(
                      eq(chatEvents.runId, zeroRuns.id),
                      chatEventTypeIn(["run.cancelled"]),
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
