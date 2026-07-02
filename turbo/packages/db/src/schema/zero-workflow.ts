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
    // Hard 1:N ownership: every workflow belongs to exactly one agent. Deleting
    // the agent cascades to its workflows and their volumes.
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return zeroAgents.id;
        },
        { onDelete: "cascade" },
      ),
    name: varchar("name", { length: 64 }).notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<ZeroWorkflowVisibility>()
      .notNull()
      .default("private"),
    // Pending promotion request. Only meaningful while `visibility = 'private'`;
    // cleared back to false when the workflow becomes public.
    requestToPublish: boolean("request_to_publish").notNull().default(false),
    // Instruction body (the SKILL.md content below the frontmatter). DB is the
    // single source of truth; the SKILL.md written to the volume is synthesized
    // from (name, description, instruction).
    instruction: text("instruction"),
    ownerUserId: text("owner_user_id").notNull(),
    displayName: varchar("display_name", { length: 256 }),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      agentIdx: index("idx_zero_workflows_agent").on(table.agentId, table.name),
      // Public workflow slugs are the shared namespace for an agent. Private
      // workflows may duplicate public slugs as user-specific forks/overrides,
      // but one owner cannot have two private workflows with the same slug on
      // the same agent.
      publicAgentNameIdx: uniqueIndex(
        "idx_zero_workflows_public_agent_name_unique",
      )
        .on(table.orgId, table.agentId, table.name)
        .where(sql`visibility = 'public'`),
      privateOwnerAgentNameIdx: uniqueIndex(
        "idx_zero_workflows_private_owner_agent_name_unique",
      )
        .on(table.orgId, table.agentId, table.ownerUserId, table.name)
        .where(sql`visibility = 'private'`),
      orgIdx: index("idx_zero_workflows_org").on(table.orgId),
      ownerIdx: index("idx_zero_workflows_org_owner").on(
        table.orgId,
        table.ownerUserId,
      ),
    };
  },
);

/**
 * Shared trigger chat thread for one workflow execution owner.
 *
 * Trigger-fired runs use the trigger owner's identity. Keep the linked chat
 * thread at the workflow-user level so every trigger owned by the same user
 * for a workflow writes to one conversation.
 */
export const workflowUserTriggerThreads = pgTable(
  "workflow_user_trigger_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflows.id;
        },
        { onDelete: "cascade" },
      ),
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_workflow_user_trigger_threads_unique").on(
        table.orgId,
        table.userId,
        table.workflowId,
      ),
      index("idx_workflow_user_trigger_threads_chat_thread").on(
        table.chatThreadId,
      ),
      index("idx_workflow_user_trigger_threads_workflow_user").on(
        table.workflowId,
        table.userId,
      ),
    ];
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
export type ZeroWorkflowEventType =
  | "gmail-new-message"
  | "gmail-label-applied"
  | "github-label-applied"
  | "google-calendar-event-created"
  | "google-calendar-event-updated"
  | "google-calendar-event-cancelled"
  | "google-meet-transcript-generated"
  | "webhook-received";
export type ZeroWorkflowEventConfig = Record<string, unknown>;

/**
 * Workflow triggers.
 *
 * A trigger answers "when" (schedule) and "where" (agent) a workflow runs; the
 * workflow's SKILL.md is the "what". Trigger chat is shared at the
 * workflow-user level by `workflow_user_trigger_threads`.
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
    eventConfig: jsonb("event_config").$type<ZeroWorkflowEventConfig>(),
    scheduleType: varchar("schedule_type", {
      length: 16,
    }).$type<ZeroWorkflowScheduleType>(),
    cronExpression: varchar("cron_expression", { length: 100 }),
    intervalSeconds: integer("interval_seconds"),
    atTime: timestamp("at_time"),
    timezone: varchar("timezone", { length: 50 }).default("UTC").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
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
            AND event_config IS NULL
            AND (
              (schedule_type = 'cron' AND cron_expression IS NOT NULL AND interval_seconds IS NULL AND at_time IS NULL)
              OR (schedule_type = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)
              OR (schedule_type = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
            )
          )
          OR (
            kind = 'event'
            AND event_type IN ('gmail-new-message', 'gmail-label-applied', 'github-label-applied', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-meet-transcript-generated', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          )`,
      ),
    ];
  },
);

export const zeroWorkflowWebhookTriggers = pgTable(
  "zero_workflow_webhook_triggers",
  {
    triggerId: uuid("trigger_id")
      .primaryKey()
      .references(
        () => {
          return zeroWorkflowTriggers.id;
        },
        { onDelete: "cascade" },
      ),
    tokenHash: text("token_hash").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    encryptedSecret: text("encrypted_secret").notNull(),
    secretLastFour: varchar("secret_last_four", { length: 4 }).notNull(),
    lastReceivedAt: timestamp("last_received_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_zero_workflow_webhook_triggers_token_hash").on(
        table.tokenHash,
      ),
    ];
  },
);

export const zeroWorkflowWebhookDeliveries = pgTable(
  "zero_workflow_webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflowTriggers.id;
        },
        { onDelete: "cascade" },
      ),
    deliveryKey: text("delivery_key").notNull(),
    bodySha256: text("body_sha256").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    runId: uuid("run_id"),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_zero_workflow_webhook_deliveries_key").on(
        table.triggerId,
        table.deliveryKey,
      ),
      index("idx_zero_workflow_webhook_deliveries_received").on(
        table.triggerId,
        table.receivedAt,
      ),
    ];
  },
);

export const zeroWorkflowGithubProcessedEvents = pgTable(
  "zero_workflow_github_processed_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflowTriggers.id;
        },
        { onDelete: "cascade" },
      ),
    githubDeliveryId: varchar("github_delivery_id", { length: 255 }).notNull(),
    repo: varchar("repo", { length: 255 }).notNull(),
    subjectType: varchar("subject_type", { length: 32 }).notNull(),
    subjectNumber: integer("subject_number").notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    labelNameNormalized: varchar("label_name_normalized", {
      length: 255,
    }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_zero_workflow_github_processed_delivery").on(
        table.triggerId,
        table.githubDeliveryId,
      ),
      index("idx_zero_workflow_github_processed_subject").on(
        table.repo,
        table.subjectType,
        table.subjectNumber,
      ),
    ];
  },
);
