import { agentRuns } from "@vm0/db/schema/agent-run";
import { sql, type SQL } from "drizzle-orm";

export function activePendingRunPredicate(staleThreshold: Date): SQL<boolean> {
  return sql<boolean>`(
    ${agentRuns.lastHeartbeatAt} > ${sql.param(staleThreshold, agentRuns.lastHeartbeatAt)}
    OR (
      ${agentRuns.lastHeartbeatAt} IS NULL
      AND ${agentRuns.createdAt} > ${sql.param(staleThreshold, agentRuns.createdAt)}
    )
  )`;
}
