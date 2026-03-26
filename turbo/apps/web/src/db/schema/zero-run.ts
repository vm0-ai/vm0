import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Zero Runs table
 * Stores Zero-specific run metadata (trigger source) as first-class columns.
 * PK is the agent_runs.id — extends agent_runs with Zero-layer context.
 */
export const zeroRuns = pgTable("zero_runs", {
  id: uuid("id")
    .primaryKey()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  triggerSource: varchar("trigger_source", { length: 20 }).notNull(),
});
