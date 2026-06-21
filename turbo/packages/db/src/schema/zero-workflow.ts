import {
  pgTable,
  uuid,
  timestamp,
  text,
  varchar,
  integer,
  boolean,
  uniqueIndex,
  index,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { zeroAgents } from "./zero-agent";
import { chatThreads } from "./chat-thread";

/**
 * Zero workflow visibility.
 *
 * Public workflows are visible within the org. Private workflows are visible
 * only to their owner. The backing package is still a skill directory and is
 * stored through the existing custom-skill volume storage name.
 */
export type ZeroWorkflowVisibility = "public" | "private";
export type ZeroWorkflowType = "workflow" | "goal";

export interface ZeroGoalPreference {
  readonly version: 1;
  readonly objective: string;
  readonly tokenBudget?: number;
  readonly stopReason?: "paused" | "blocked" | "failed";
}

export type ZeroWorkflowPreference = ZeroGoalPreference;

/**
 * Zero Workflows table
 * Org-scoped registry of workflows. Each row represents workflow metadata.
 * Workflow content is stored in the storages system.
 */
export const zeroWorkflows = pgTable(
  "zero_workflows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<ZeroWorkflowVisibility>()
      .notNull()
      .default("private"),
    type: varchar("type", { length: 16 })
      .$type<ZeroWorkflowType>()
      .notNull()
      .default("workflow"),
    active: boolean("active").default(true).notNull(),
    preference: jsonb("preference").$type<ZeroWorkflowPreference>(),
    ownerUserId: text("owner_user_id").notNull(),
    displayName: varchar("display_name", { length: 256 }),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      orgNameIdx: uniqueIndex("idx_zero_workflows_org_name").on(
        table.orgId,
        table.name,
      ),
      orgIdx: index("idx_zero_workflows_org").on(table.orgId),
      ownerIdx: index("idx_zero_workflows_org_owner").on(
        table.orgId,
        table.ownerUserId,
      ),
    };
  },
);

/**
 * Workflow-agent attachments.
 *
 * Sparse model: presence of a row means the workflow is attached to the agent.
 * Runtime loading still filters these rows by current-user workflow visibility.
 */
export const zeroWorkflowAgents = pgTable(
  "zero_workflow_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflows.id;
        },
        { onDelete: "cascade" },
      ),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return zeroAgents.id;
        },
        { onDelete: "cascade" },
      ),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      workflowAgentIdx: uniqueIndex(
        "idx_zero_workflow_agents_workflow_agent",
      ).on(table.workflowId, table.agentId),
      agentIdx: index("idx_zero_workflow_agents_agent").on(
        table.orgId,
        table.agentId,
      ),
      workflowIdx: index("idx_zero_workflow_agents_workflow").on(
        table.orgId,
        table.workflowId,
      ),
    };
  },
);

/**
 * Schedule sub-type for a workflow trigger.
 *
 * - `cron`: recurring at wall-clock times defined by a cron expression.
 * - `loop`: re-scheduled `interval_seconds` after each completion (no overlap).
 * - `once`: fires once at `at_time`, then auto-disables.
 *
 * Aligned with Automation's time-trigger semantics so the same scheduling
 * primitives (`TimeTrigger`) can be reused.
 */
export type ZeroWorkflowScheduleType = "cron" | "loop" | "once";
export type ZeroWorkflowTriggerKind = "schedule" | "event";
export type ZeroWorkflowEventType = "thread-idle";

/**
 * Workflow triggers.
 *
 * A trigger answers "when" (schedule) and "where" (agent) a workflow runs; the
 * workflow's SKILL.md is the "what". Each trigger binds to its own chat thread
 * and runs under its `owner_user_id` identity.
 *
 * Schedule triggers are polled by `next_run_at`. Event triggers keep
 * `next_run_at = NULL` and fire from their event-specific junction.
 */
export const zeroWorkflowTriggers = pgTable(
  "zero_workflow_triggers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflows.id;
        },
        { onDelete: "cascade" },
      ),
    // Nullable: cleared to NULL (and the trigger disabled) when the agent is
    // deleted, since a trigger lives as long as its workflow.
    agentId: uuid("agent_id").references(
      () => {
        return zeroAgents.id;
      },
      { onDelete: "set null" },
    ),
    // Execution identity: runs fire as (org_id, owner_user_id), resolving the
    // owner's secrets / connectors / credits.
    ownerUserId: text("owner_user_id").notNull(),
    kind: varchar("kind", { length: 16 })
      .$type<ZeroWorkflowTriggerKind>()
      .notNull()
      .default("schedule"),
    eventType: varchar("event_type", {
      length: 64,
    }).$type<ZeroWorkflowEventType>(),
    scheduleType: varchar("schedule_type", {
      length: 16,
    }).$type<ZeroWorkflowScheduleType>(),
    cronExpression: varchar("cron_expression", { length: 100 }),
    intervalSeconds: integer("interval_seconds"),
    atTime: timestamp("at_time"),
    timezone: varchar("timezone", { length: 50 }).default("UTC").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    // Nullable: the bound thread is removed when its agent is deleted
    // (chat_threads.agent_compose_id ON DELETE CASCADE).
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    nextRunAt: timestamp("next_run_at"),
    lastRunAt: timestamp("last_run_at"),
    lastRunId: uuid("last_run_id"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_zero_workflow_triggers_workflow").on(table.workflowId),
      index("idx_zero_workflow_triggers_org").on(table.orgId),
      index("idx_zero_workflow_triggers_chat_thread").on(table.chatThreadId),
      uniqueIndex("idx_zero_workflow_triggers_thread_idle_thread_unique")
        .on(table.orgId, table.chatThreadId)
        .where(
          sql`chat_thread_id IS NOT NULL AND kind = 'event' AND event_type = 'thread-idle'`,
        ),
      // Partial index for the time poller: enabled triggers with a due next run.
      index("idx_zero_workflow_triggers_next_run")
        .on(table.nextRunAt)
        .where(sql`enabled = true`),
      // Each trigger kind carries exactly its own config.
      check(
        "zero_workflow_triggers_schedule_config_check",
        sql`(
            kind = 'schedule'
            AND event_type IS NULL
            AND (
              (schedule_type = 'cron' AND cron_expression IS NOT NULL AND interval_seconds IS NULL AND at_time IS NULL)
              OR (schedule_type = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)
              OR (schedule_type = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
            )
          )
          OR (
            kind = 'event'
            AND event_type = 'thread-idle'
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          )`,
      ),
    ];
  },
);
