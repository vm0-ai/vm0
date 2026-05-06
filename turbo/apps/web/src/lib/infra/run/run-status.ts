import { and, eq, inArray } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { dispatchCallbacks } from "../callback";
import { logger } from "../../shared/logger";
import { buildRunResultFromCheckpoint } from "./run-result";
import type { RunResult, RunStatus } from "./types";
import type { Database } from "../../../types/global";
import type { SandboxReuseResult } from "@vm0/api-contracts/contracts/webhooks";

const log = logger("service:run-status");

type RunStatusUpdate = {
  status: RunStatus;
  completedAt?: Date;
  startedAt?: Date;
  lastHeartbeatAt?: Date;
  error?: string;
  result?: RunResult;
  sandboxId?: string;
  sandboxReuseResult?: SandboxReuseResult;
};

type TransitionDb = Pick<Database, "select" | "update">;

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);

function shouldAttachExistingCheckpointResult(
  update: RunStatusUpdate,
): boolean {
  return (
    TERMINAL_RUN_STATUSES.has(update.status) && update.result === undefined
  );
}

async function buildExistingCheckpointRunResult(
  runId: string,
  db: Pick<Database, "select">,
): Promise<RunResult | undefined> {
  const [checkpoint] = await db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.runId, runId))
    .limit(1);

  if (!checkpoint) {
    return undefined;
  }

  const [session] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.conversationId, checkpoint.conversationId))
    .limit(1);

  return buildRunResultFromCheckpoint(checkpoint, session?.id);
}

async function transitionRunStatusWithDb(
  runId: string,
  update: RunStatusUpdate,
  allowedFromStatuses: RunStatus[],
  db: TransitionDb,
  attachExistingCheckpointResult: boolean,
): Promise<boolean> {
  if (attachExistingCheckpointResult) {
    const [lockedRun] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, runId),
          inArray(agentRuns.status, allowedFromStatuses),
        ),
      )
      .for("update")
      .limit(1);

    if (!lockedRun) {
      return false;
    }
  }

  const checkpointResult = attachExistingCheckpointResult
    ? await buildExistingCheckpointRunResult(runId, db)
    : undefined;
  const nextUpdate: RunStatusUpdate = checkpointResult
    ? { ...update, result: checkpointResult }
    : update;

  const [updated] = await db
    .update(agentRuns)
    .set(nextUpdate)
    .where(
      and(
        eq(agentRuns.id, runId),
        inArray(agentRuns.status, allowedFromStatuses),
      ),
    )
    .returning({ id: agentRuns.id });
  return !!updated;
}

/**
 * Atomically transition a run to a new status.
 * Only succeeds if the current status is in allowedFromStatuses.
 * Returns true if the transition was applied, false if the run was
 * already in a different status (lost the race).
 */
export async function transitionRunStatus(
  runId: string,
  update: RunStatusUpdate,
  allowedFromStatuses: RunStatus[],
  db?: TransitionDb,
): Promise<boolean> {
  const attachExistingCheckpointResult =
    shouldAttachExistingCheckpointResult(update);

  if (db) {
    return transitionRunStatusWithDb(
      runId,
      update,
      allowedFromStatuses,
      db,
      attachExistingCheckpointResult,
    );
  }

  if (attachExistingCheckpointResult) {
    return globalThis.services.db.transaction((tx) => {
      return transitionRunStatusWithDb(
        runId,
        update,
        allowedFromStatuses,
        tx,
        true,
      );
    });
  }

  return transitionRunStatusWithDb(
    runId,
    update,
    allowedFromStatuses,
    globalThis.services.db,
    false,
  );
}

/**
 * Dispatch side effects after a successful terminal status transition.
 *
 * Every terminal transition (completed, failed, timeout, cancelled) must call
 * this to ensure:
 * 1. Registered callbacks fire (e.g., loop schedule advancement)
 * 2. Concurrency slots are released via queue drain
 *
 * @param drain - Optional queue drain function. Injected by callers to avoid
 *   circular dependency with run-queue-service. Omit when callbacks are not
 *   yet registered (e.g., markQueuedRunFailed for runs that never dispatched).
 */
export async function dispatchTerminalSideEffects(
  runId: string,
  status: RunStatus,
  options: {
    error?: string;
    result?: RunResult;
    drain?: () => Promise<void>;
  } = {},
): Promise<void> {
  const callbackStatus = status === "completed" ? "completed" : "failed";
  await dispatchCallbacks(
    runId,
    callbackStatus,
    options.result,
    options.error,
  ).catch((err) => {
    return log.error("Failed to dispatch callbacks", { err });
  });
  if (options.drain) {
    await options.drain().catch((err) => {
      return log.error("Failed to drain org queue", { err });
    });
  }
}
