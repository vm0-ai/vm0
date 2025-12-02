import { pgTable, uuid, timestamp, real, bigint } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Sandbox Metrics table
 * Stores resource usage metrics collected from E2B sandboxes
 * Metrics are collected every 5 seconds during agent execution
 */
export const sandboxMetrics = pgTable("sandbox_metrics", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(() => agentRuns.id, { onDelete: "cascade" })
    .notNull(),
  timestamp: timestamp("timestamp").notNull(),
  cpuUsedPct: real("cpu_used_pct").notNull(),
  memUsed: bigint("mem_used", { mode: "number" }).notNull(),
  memTotal: bigint("mem_total", { mode: "number" }).notNull(),
  diskUsed: bigint("disk_used", { mode: "number" }).notNull(),
  diskTotal: bigint("disk_total", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
