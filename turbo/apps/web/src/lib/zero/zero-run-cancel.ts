import { eq, and } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { transitionRunStatus } from "../infra/run/run-status";
import { publishRunChangedForUserSafely } from "../infra/run/run-realtime";
import { notFound, runNotCancellable } from "@vm0/api-services/errors";
import { publishOrgSignal } from "./realtime";

/**
 * Result of a cancel request. Side effects should only fire when
 * `alreadyCancelled` is false — otherwise this call was an idempotent replay
 * of a previously-successful cancel and the original caller already dispatched
 * queue drain / credit processing / terminal callbacks.
 */
interface CancelRunResult {
  runId: string;
  previousStatus: string;
  userId: string;
  orgId: string;
  sandboxId: string | null;
  runnerGroup: string | null;
  alreadyCancelled: boolean;
}

/**
 * Cancel a run. Idempotent for already-cancelled runs: returns success without
 * dispatching side effects. Throws NotFound if the run doesn't exist, and
 * RunNotCancellable (400 / RUN_NOT_CANCELLABLE) for other terminal statuses.
 */
export async function cancelRun(
  runId: string,
  userId: string,
  orgId: string,
): Promise<CancelRunResult> {
  const db = globalThis.services.db;

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.userId, userId),
        eq(agentRuns.orgId, orgId),
      ),
    )
    .limit(1);

  if (!run) {
    throw notFound(`No such run: '${runId}'`);
  }

  if (run.status === "cancelled") {
    return {
      runId,
      previousStatus: run.status,
      userId: run.userId,
      orgId: run.orgId,
      sandboxId: run.sandboxId,
      runnerGroup: run.runnerGroup,
      alreadyCancelled: true,
    };
  }

  if (
    run.status !== "queued" &&
    run.status !== "pending" &&
    run.status !== "running"
  ) {
    throw runNotCancellable(
      `Run cannot be cancelled: current status is '${run.status}'`,
    );
  }

  const cancelled = await db.transaction(async (tx) => {
    await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, runId));
    return transitionRunStatus(
      runId,
      { status: "cancelled", completedAt: new Date() },
      ["queued", "pending", "running"],
      tx,
    );
  });

  if (cancelled) {
    // Notify all org members whose queue view should refresh.
    await publishOrgSignal(run.orgId, "queue:changed");
    await publishRunChangedForUserSafely(run.userId, runId, {
      status: "cancelled",
    });

    return {
      runId,
      previousStatus: run.status,
      userId: run.userId,
      orgId: run.orgId,
      sandboxId: run.sandboxId,
      runnerGroup: run.runnerGroup,
      alreadyCancelled: false,
    };
  }

  // Concurrent writer won the transition. Re-read to classify the outcome:
  // if the winner moved the row to 'cancelled', the user's intent is satisfied
  // and we respond idempotently; any other terminal state is a genuine error.
  const [current] = await db
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (current?.status === "cancelled") {
    return {
      runId,
      previousStatus: "cancelled",
      userId: run.userId,
      orgId: run.orgId,
      sandboxId: run.sandboxId,
      runnerGroup: run.runnerGroup,
      alreadyCancelled: true,
    };
  }

  throw runNotCancellable(
    `Run cannot be cancelled: status has already changed`,
  );
}
