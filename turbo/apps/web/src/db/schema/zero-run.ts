import {
  type AnyPgColumn,
  pgTable,
  uuid,
  varchar,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuns } from "./agent-run";
import { zeroAgentSchedules } from "./zero-agent-schedule";

/**
 * Zero Runs table
 * Stores Zero-specific run metadata (trigger source, schedule) as first-class columns.
 * PK is the agent_runs.id — extends agent_runs with Zero-layer context.
 */
export const zeroRuns = pgTable(
  "zero_runs",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    triggerSource: varchar("trigger_source", { length: 20 }).notNull(),
    // References zero_agent_schedules.id if this run was triggered by a schedule
    scheduleId: uuid("schedule_id").references(
      (): AnyPgColumn => zeroAgentSchedules.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    index("idx_zero_runs_schedule")
      .on(table.scheduleId)
      .where(sql`schedule_id IS NOT NULL`),
  ],
);
