import { agentRuns } from "@okouai/db/schema/agent-run";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { cancelLockedRun } from "./agent-run-cancellation-transition.service";
import { insertChatEvent } from "./chat-event.service";
import { revokeQueuedRunAssistantMarkers } from "./chat-queue-marker.service";
import { lockPiApiFirstTurnLifecycle } from "./pi-api-first-turn-lifecycle.service";

const log = logger("api:goal-retirement");
export const GOAL_RETIRED_MESSAGE =
  "Okou Goals have been retired. Continue with a regular chat message.";

export interface RetiredGoalRun {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string | null;
}

/**
 * Temporary settlement for persisted jobs and outgoing API/runner/Pi contexts
 * under #32653. Keep through their measured queue/execution/callback drain;
 * remove only after outgoing writers quiesce, global pending Goal inputs and
 * nonterminal Goal runs are empty, and rollback stays retirement-capable.
 * Lock order matches cancellation: Pi lifecycle -> run -> queue. Source and
 * status are checked under the same lock as cancellation; running work wins.
 * goalId is provenance only and must never classify a manual run as Goal work.
 */
export async function retirePendingGoalRunInTransaction(
  tx: Tx,
  runId: string,
): Promise<RetiredGoalRun | null> {
  // Ordinary runner claims must not join the Goal retirement lock protocol:
  // Sandbox ownership can legitimately win while Pi publication holds it.
  // This source-only probe authorizes no cancellation; revalidate the actual
  // source and current status under the lifecycle and row locks below.
  const [candidate] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.triggerSource, "goal")));
  if (!candidate) {
    return null;
  }
  await lockPiApiFirstTurnLifecycle(tx, runId);
  const [run] = await tx
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      chatThreadId: agentRuns.chatThreadId,
      goalId: agentRuns.goalId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.triggerSource, "goal")))
    .for("update");
  if (!run || (run.status !== "queued" && run.status !== "pending")) {
    return null;
  }
  await cancelLockedRun(tx, {
    runId,
    status: run.status,
    completedAt: nowDate(),
    error: GOAL_RETIRED_MESSAGE,
  });
  await revokeQueuedRunAssistantMarkers(tx, { runId, userId: run.userId });
  if (run.chatThreadId) {
    // The canonical terminal marker also makes a delayed callback idempotent:
    // retirement must not synthesize completion automations or notifications.
    await insertChatEvent(
      tx,
      {
        chatThreadId: run.chatThreadId,
        eventType: "run.cancelled",
        content: GOAL_RETIRED_MESSAGE,
        error: GOAL_RETIRED_MESSAGE,
        runId,
        runGroupId: run.goalId ?? undefined,
      },
      "run-lifecycle",
    );
  }
  return run;
}

export async function publishGoalRunRetirement(
  run: RetiredGoalRun,
): Promise<void> {
  log.debug("Pending goal run retired", { runId: run.id, orgId: run.orgId });
  if (run.chatThreadId) {
    await publishChatThreadMessageCreatedSafely({
      userId: run.userId,
      orgId: run.orgId,
      threadId: run.chatThreadId,
    });
    await publishThreadListChanged({ userId: run.userId, orgId: run.orgId });
  }
}

export async function retirePendingGoalRun(
  db: Db,
  runId: string,
): Promise<RetiredGoalRun | null> {
  return await db.transaction(async (tx) => {
    return await retirePendingGoalRunInTransaction(tx, runId);
  });
}

export interface GoalRunRetirement {
  readonly kind: "goal-retired";
  readonly run: RetiredGoalRun;
}
