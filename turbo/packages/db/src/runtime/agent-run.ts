import { pgTable } from "drizzle-orm/pg-core";
import { agentRunColumns } from "../columns/agent-run";
import { resolveAgentSessionId } from "../schema/agent-run-reference";

/** Application mapping. Keep outside src/schema and its re-exports until S5. */
export const agentRuns = pgTable(
  "agent_runs",
  agentRunColumns(resolveAgentSessionId),
);
