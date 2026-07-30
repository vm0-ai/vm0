import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@vm0/api-contracts/contracts/runners";
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
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Db } from "../external/db";
import { nowDate } from "../external/time";
import { pendingChatQueueEventCondition } from "./chat-event-queue.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

const ACTIVE_CHAT_RUN_STATUSES = ["queued", "pending", "running"] as const;

function unresolvedCancellationRecoveryCondition(
  db: Pick<Db, "select">,
  completedAtCondition: SQL,
) {
  return and(
    eq(agentRuns.status, "cancelled"),
    isNotNull(agentRuns.cancellationRecoveryCompleted),
    completedAtCondition,
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
  );
}

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
          unresolvedCancellationRecoveryCondition(
            db,
            gt(
              agentRuns.completedAt,
              new Date(
                nowDate().getTime() - CANCELLATION_RECOVERY_STALE_AFTER_MS,
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

/** Pending queue threads whose cancellation recovery barrier has failed open. */
export async function expiredCancellationRecoveryThreadIds(
  db: Pick<Db, "select" | "selectDistinct">,
  args: {
    readonly expiredBefore: Date;
    readonly limit: number;
  },
): Promise<readonly string[]> {
  const rows = await db
    .selectDistinct({ chatThreadId: chatEvents.chatThreadId })
    .from(chatEvents)
    .where(
      and(
        pendingChatQueueEventCondition(db),
        exists(
          db
            .select({ id: zeroRuns.id })
            .from(zeroRuns)
            .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
            .where(
              and(
                eq(zeroRuns.chatThreadId, chatEvents.chatThreadId),
                unresolvedCancellationRecoveryCondition(
                  db,
                  lte(agentRuns.completedAt, args.expiredBefore),
                ),
              ),
            ),
        ),
      ),
    )
    .limit(args.limit);
  return rows.map((row) => {
    return row.chatThreadId;
  });
}
