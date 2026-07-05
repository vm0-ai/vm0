import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentComposes } from "./agent-compose";
import { agentRuns } from "./agent-run";
import { chatThreads } from "./chat-thread";

// Legacy schedule automation tables. These definitions are intentionally not
// exported from the main database schema object; migration 0545 drops the
// physical tables. They remain only for historical migration scripts and
// old test fixtures until those fixtures are rewritten.
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runGroupId: uuid("run_group_id").defaultRandom().notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    description: text("description"),
    instruction: text("instruction").notNull(),
    appendSystemPrompt: text("append_system_prompt"),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      ),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    interpreterKind: varchar("interpreter_kind", { length: 32 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    migratedToWorkflowId: uuid("migrated_to_workflow_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_automations_agent").on(table.agentId),
      index("idx_automations_org").on(table.orgId),
      index("idx_automations_user_org").on(table.userId, table.orgId),
      index("idx_automations_chat_thread").on(table.chatThreadId),
      uniqueIndex("idx_automations_run_group").on(table.runGroupId),
      uniqueIndex("idx_automations_agent_name_org_user").on(
        table.agentId,
        table.name,
        table.orgId,
        table.userId,
      ),
    ];
  },
);

export const automationTriggers = pgTable(
  "automation_triggers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return automations.id;
        },
        { onDelete: "cascade" },
      ),
    kind: varchar("kind", { length: 32 }).notNull(),
    config: jsonb("config").$type<Record<string, unknown>>(),
    cronExpression: varchar("cron_expression", { length: 100 }),
    atTime: timestamp("at_time"),
    intervalSeconds: integer("interval_seconds"),
    timezone: varchar("timezone", { length: 50 }).default("UTC").notNull(),
    nextRunAt: timestamp("next_run_at"),
    lastRunAt: timestamp("last_run_at"),
    lastRunId: uuid("last_run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_automation_triggers_automation").on(table.automationId),
      index("idx_automation_triggers_next_run")
        .on(table.nextRunAt)
        .where(sql`enabled = true`),
      check(
        "automation_triggers_kind_config_check",
        sql`(kind = 'cron' AND cron_expression IS NOT NULL AND at_time IS NULL AND interval_seconds IS NULL)
          OR (kind = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
          OR (kind = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)`,
      ),
    ];
  },
);
