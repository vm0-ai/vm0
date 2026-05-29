import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuns } from "./agent-run";
import { agentComposes } from "./agent-compose";

/**
 * Zero Agent Schedules table
 * Stores schedule configurations for automated agent runs
 * Supports 1:N (one agent can have multiple named schedules)
 *
 * Each schedule carries its own (orgId, userId) pair for execution identity.
 * This allows cross-org sharing: User B (org-b) can schedule User A's
 * agent (org-a) and the schedule resolves secrets from org-b + user-b.
 *
 * Note: The migration includes a CHECK constraint (trigger_check) ensuring
 * exactly one trigger type is set, matching the trigger_type column:
 * - 'cron': cron_expression NOT NULL, at_time NULL, interval_seconds NULL
 * - 'once': cron_expression NULL, at_time NOT NULL, interval_seconds NULL
 * - 'loop': cron_expression NULL, at_time NULL, interval_seconds NOT NULL
 */
export const zeroAgentSchedules = pgTable(
  "zero_agent_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      ),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),

    // Trigger type discriminator: 'cron' | 'once' | 'loop'
    triggerType: varchar("trigger_type", { length: 20 })
      .notNull()
      .default("cron"),

    // Trigger configuration (mutually exclusive based on trigger_type)
    cronExpression: varchar("cron_expression", { length: 100 }),
    atTime: timestamp("at_time"),
    intervalSeconds: integer("interval_seconds"),
    timezone: varchar("timezone", { length: 50 }).default("UTC").notNull(),

    // What to run
    prompt: text("prompt").notNull(),
    description: text("description"),
    appendSystemPrompt: text("append_system_prompt"),
    vars: jsonb("vars").$type<Record<string, string>>(),
    // Secrets encrypted with the API stored-secret encryption envelope.
    encryptedSecrets: text("encrypted_secrets"),

    volumeVersions: jsonb("volume_versions").$type<Record<string, string>>(),

    // State
    enabled: boolean("enabled").default(true).notNull(),
    nextRunAt: timestamp("next_run_at"),
    lastRunAt: timestamp("last_run_at"),
    lastRunId: uuid("last_run_id").references(
      () => {
        return agentRuns.id;
      },
      {
        onDelete: "set null",
      },
    ),
    // Tracks when retry cycle started for concurrency failures (null = not retrying)
    retryStartedAt: timestamp("retry_started_at"),
    // Tracks consecutive failures for loop schedules (auto-disable after 3)
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Index for finding schedules by agent
      index("idx_zero_agent_schedules_zero_agent").on(table.agentId),
      index("idx_zero_agent_schedules_org").on(table.orgId),
      uniqueIndex("idx_zero_agent_schedules_agent_name_org_user").on(
        table.agentId,
        table.name,
        table.orgId,
        table.userId,
      ),
      // Partial index for efficient cron polling: enabled schedules with due next_run_at
      index("idx_zero_agent_schedules_next_run")
        .on(table.nextRunAt)
        .where(sql`enabled = true`),
      // Index for user schedule listing (listSchedules filters by userId + optional orgId)
      index("idx_zero_agent_schedules_user_org").on(table.userId, table.orgId),
    ];
  },
);
