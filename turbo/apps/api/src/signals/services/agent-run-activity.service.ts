import { agentRuns } from "@okouai/db/schema/agent-run";
import { and, gt, isNull, or, type SQL } from "drizzle-orm";

export function activePendingRunPredicate(staleThreshold: Date): SQL {
  return or(
    gt(agentRuns.lastHeartbeatAt, staleThreshold),
    and(
      isNull(agentRuns.lastHeartbeatAt),
      gt(agentRuns.createdAt, staleThreshold),
    ),
  ) as SQL;
}
