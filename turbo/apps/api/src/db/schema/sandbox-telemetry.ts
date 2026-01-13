import { pgTable, uuid, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Sandbox Telemetry table
 * Stores telemetry data (system log and metrics) from sandbox execution
 */
export const sandboxTelemetry = pgTable(
  "sandbox_telemetry",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => agentRuns.id, { onDelete: "cascade" })
      .notNull(),
    data: jsonb("data").notNull(), // { systemLog: string, metrics: array }
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_sandbox_telemetry_run_id").on(table.runId)],
);
