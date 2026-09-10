import { pgTable } from "drizzle-orm/pg-core";
import { agentRunColumns } from "../columns/agent-run";
import { resolveAgentSessionId } from "../schema/agent-run-reference";

/** Application mapping. Shares the physical schema column factory; omits DDL declarations. */
export const agentRuns = pgTable(
  "agent_runs",
  agentRunColumns(resolveAgentSessionId),
);
