import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  unique,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Runners table
 * Represents self-hosted runners that can execute agent runs
 * Runners authenticate via CLI tokens (same as CLI) and register with a group
 */
export const runners = pgTable(
  "runners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID - owner of this runner
    name: varchar("name", { length: 255 }).notNull(), // Runner name (e.g., "ci-runner-1")
    runnerGroup: varchar("runner_group", { length: 255 }).notNull(), // Group in scope/name format (e.g., "acme/production")
    status: varchar("status", { length: 20 }).default("offline").notNull(), // online, offline, busy
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // A user can only have one runner with the same name
    unique("runners_user_id_name_unique").on(table.userId, table.name),
  ],
);

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
    runnerId: uuid("runner_id").references(() => runners.id),
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
