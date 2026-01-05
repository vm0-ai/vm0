import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Runner Job Queue table
 * Temporary storage for runner jobs with encrypted secrets
 * Records are deleted after job completion
 */
export const runnerJobQueue = pgTable(
  "runner_job_queue",
  {
    // Primary key, references agent_runs
    runId: uuid("run_id")
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: "cascade" }),

    // Runner routing
    runnerGroup: varchar("runner_group", { length: 255 }).notNull(),

    // Claim status
    claimedAt: timestamp("claimed_at"),

    // Execution context (secrets encrypted with AES-256-GCM)
    executionContext: jsonb("execution_context").notNull(),

    // Lifecycle management
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(), // TTL for auto-cleanup
  },
  (table) => [
    // Index for polling unclaimed jobs by group
    index("runner_job_queue_group_unclaimed_idx")
      .on(table.runnerGroup)
      .where("claimed_at IS NULL" as never),
    // Index for TTL cleanup
    index("runner_job_queue_expires_at_idx").on(table.expiresAt),
  ],
);
