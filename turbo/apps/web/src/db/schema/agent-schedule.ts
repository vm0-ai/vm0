import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";
import { agentRuns } from "./agent-run";

/**
 * Agent Schedules table
 * Stores schedule configurations for automated agent runs
 * Database supports 1:N (one agent can have multiple schedules)
 * API enforces 1:1 in initial version (single schedule per agent)
 *
 * Note: The migration includes a CHECK constraint (trigger_check) ensuring
 * exactly one trigger type is set: (cron_expression IS NOT NULL AND at_time IS NULL)
 * OR (cron_expression IS NULL AND at_time IS NOT NULL)
 */
export const agentSchedules = pgTable(
  "agent_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    composeId: uuid("compose_id")
      .notNull()
      .references(() => agentComposes.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),

    // Trigger configuration (mutually exclusive: cron XOR at)
    cronExpression: varchar("cron_expression", { length: 100 }),
    atTime: timestamp("at_time"),
    timezone: varchar("timezone", { length: 50 }).default("UTC").notNull(),

    // What to run
    prompt: text("prompt").notNull(),
    vars: jsonb("vars").$type<Record<string, string>>(),
    // Secrets encrypted with AES-256-GCM (same pattern as runner_job_queue)
    encryptedSecrets: text("encrypted_secrets"),

    // Artifact configuration
    artifactName: varchar("artifact_name", { length: 255 }),
    artifactVersion: varchar("artifact_version", { length: 64 }),
    volumeVersions: jsonb("volume_versions").$type<Record<string, string>>(),

    // State
    enabled: boolean("enabled").default(true).notNull(),
    nextRunAt: timestamp("next_run_at"),
    lastRunAt: timestamp("last_run_at"),
    lastRunId: uuid("last_run_id").references(() => agentRuns.id),
    // Tracks when retry cycle started for concurrency failures (null = not retrying)
    retryStartedAt: timestamp("retry_started_at"),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // Schedule name unique within agent
    uniqueIndex("idx_agent_schedules_compose_name").on(
      table.composeId,
      table.name,
    ),
    // Index for finding schedules by compose
    index("idx_agent_schedules_compose").on(table.composeId),
    // Partial index for efficient cron polling: enabled schedules with due next_run_at
    index("idx_agent_schedules_next_run")
      .on(table.nextRunAt)
      .where("enabled = true" as never),
  ],
);
