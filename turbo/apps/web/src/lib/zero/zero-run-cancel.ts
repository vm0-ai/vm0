import { eq, and } from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import { agentRunQueue } from "../../db/schema/agent-run-queue";
import { transitionRunStatus } from "../infra/run/run-status";
import { notFound, badRequest } from "../shared/errors";

/**
 * Result of a successful run cancellation, used to dispatch side effects.
 */
export interface CancelRunResult {
  runId: string;
  previousStatus: string;
  orgId: string;
  sandboxId: string | null;
  runnerGroup: string | null;
}

/**
 * Cancel a run. Atomically deletes queue entry and transitions status.
 * Throws NotFound if run doesn't exist, BadRequest if run can't be cancelled.
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

  if (
    run.status !== "queued" &&
    run.status !== "pending" &&
    run.status !== "running"
  ) {
    throw badRequest(
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

  if (!cancelled) {
    throw badRequest(`Run cannot be cancelled: status has already changed`);
  }

  return {
    runId,
    previousStatus: run.status,
    orgId: run.orgId,
    sandboxId: run.sandboxId,
    runnerGroup: run.runnerGroup,
  };
}
