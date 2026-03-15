import { and, eq, inArray } from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import type { RunResult, RunStatus } from "./types";
import type { Database } from "../../types/global";

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
