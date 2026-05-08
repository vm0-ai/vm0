import { and, eq, inArray } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { dispatchCallbacks } from "../callback";
import { logger } from "../../shared/logger";
import type { RunResult, RunStatus } from "./types";
import type { Database } from "../../../types/global";
import type { SandboxReuseResult } from "@vm0/api-contracts/contracts/webhooks";

const log = logger("service:run-status");

/**
 * Atomically transition a run to a new status.
 * Only succeeds if the current status is in allowedFromStatuses.
 * Returns true if the transition was applied, false if the run was
 * already in a different status (lost the race).
 */
export async function transitionRunStatus(
  runId: string,
  update: {
    status: RunStatus;
    completedAt?: Date;
    startedAt?: Date;
    lastHeartbeatAt?: Date;
    error?: string;
    result?: RunResult;
    sandboxId?: string;
    sandboxReuseResult?: SandboxReuseResult;
  },
  allowedFromStatuses: RunStatus[],
  db?: Database,
): Promise<boolean> {
  const queryDb = db ?? globalThis.services.db;
  const [updated] = await queryDb
    .update(agentRuns)
    .set(update)
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
  error?: string,
  drain?: () => Promise<void>,
): Promise<void> {
  const callbackStatus = status === "completed" ? "completed" : "failed";
  await dispatchCallbacks(runId, callbackStatus, undefined, error).catch(
    (err) => {
      return log.error("Failed to dispatch callbacks", { err });
    },
  );
  if (drain) {
    await drain().catch((err) => {
      return log.error("Failed to drain org queue", { err });
    });
  }
}
