import { agentRuns } from "@vm0/db/schema/agent-run";
import { sql, type SQL } from "drizzle-orm";

export function activePendingRunPredicate(staleThreshold: Date): SQL<boolean> {
  return sql<boolean>`COALESCE(${agentRuns.lastHeartbeatAt}, ${agentRuns.createdAt}) > ${sql.param(
    staleThreshold,
    agentRuns.createdAt,
  )}`;
}
