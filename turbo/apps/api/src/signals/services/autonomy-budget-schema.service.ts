import { threadGoals, type ThreadGoalStatus } from "@vm0/db/schema/thread-goal";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowAutomations,
  type ZeroWorkflowAutomationKind,
  type ZeroWorkflowEventConfig,
  type ZeroWorkflowEventType,
  type ZeroWorkflowScheduleType,
} from "@vm0/db/schema/zero-workflow";
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";

import { INITIAL_AUTONOMY_BUDGET } from "./autonomy-budget.constants";

// These table views intentionally describe the pre-autonomy-budget schema.
// Drizzle includes every declared table column in INSERT statements, even
// when a value is omitted and PostgreSQL should use a default. Keeping the new
// column out of these views is what makes API-before-migration writes legal.
// Remove them after the migration and rollback window are guaranteed closed.
export const rolloutLegacyZeroRuns = pgTable("zero_runs", {
  id: uuid("id").primaryKey(),
  triggerSource: varchar("trigger_source", { length: 20 }).notNull(),
  workflowAutomationId: uuid("workflow_automation_id"),
  runGroupId: uuid("run_group_id"),
  goalId: uuid("goal_id"),
  modelProvider: varchar("model_provider", { length: 100 }),
  modelProviderId: uuid("model_provider_id"),
  modelProviderCredentialScope: varchar("model_provider_credential_scope", {
    length: 20,
  }),
  selectedModel: varchar("selected_model", { length: 255 }),
  chatThreadId: uuid("chat_thread_id"),
  apiStartedAt: timestamp("api_started_at"),
  firstAssistantEventAcknowledgedAt: timestamp(
    "first_assistant_event_acknowledged_at",
  ),
  summary: text("summary"),
  triggerBrief: text("trigger_brief"),
});

const rolloutLegacyThreadGoals = pgTable("thread_goals", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  chatThreadId: uuid("chat_thread_id").notNull(),
  status: varchar("status", { length: 16 }).$type<ThreadGoalStatus>().notNull(),
  objective: text("objective").notNull(),
  objectiveBrief: text("objective_brief").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

const rolloutLegacyWorkflowAutomations = pgTable("zero_workflow_automations", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),
  workflowId: uuid("workflow_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  kind: varchar("kind", { length: 16 })
    .$type<ZeroWorkflowAutomationKind>()
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
});

export async function autonomyBudgetSchemaAvailable(
  db: Pick<Db | ReadonlyDb, "select">,
): Promise<boolean> {
  // Keep the API safe while it can run before the autonomy-budget migration.
  // Remove this probe after the migration is guaranteed everywhere and the
  // rollback window has closed.
  const [state] = await db
    .select({
      available: sql`
        to_regclass('chat_agent_run_context') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('zero_runs')
            AND attname = 'autonomy_budget'
            AND NOT attisdropped
        )
        AND EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('thread_goals')
            AND attname = 'autonomy_budget'
            AND NOT attisdropped
        )
        AND EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('zero_workflow_automations')
            AND attname = 'autonomy_budget'
            AND NOT attisdropped
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

export function rolloutCompatibleAutonomyBudgetColumn(
  available: boolean,
  column:
    | typeof threadGoals.autonomyBudget
    | typeof zeroRuns.autonomyBudget
    | typeof zeroWorkflowAutomations.autonomyBudget,
) {
  if (available) {
    return column;
  }
  if (column === zeroRuns.autonomyBudget) {
    return sql`
      COALESCE(
        (to_jsonb(${zeroRuns}) ->> 'autonomy_budget')::integer,
        ${INITIAL_AUTONOMY_BUDGET}::integer
      )
    `.mapWith(pgIntegerDecoder);
  }
  if (column === threadGoals.autonomyBudget) {
    return sql`
      COALESCE(
        (to_jsonb(${threadGoals}) ->> 'autonomy_budget')::integer,
        ${INITIAL_AUTONOMY_BUDGET}::integer
      )
    `.mapWith(pgIntegerDecoder);
  }
  return sql`
    COALESCE(
      (to_jsonb(${zeroWorkflowAutomations}) ->> 'autonomy_budget')::integer,
      ${INITIAL_AUTONOMY_BUDGET}::integer
    )
  `.mapWith(pgIntegerDecoder);
}

export function rolloutCompatibleThreadGoalColumns(
  autonomyBudgetAvailable: boolean,
) {
  return {
    id: threadGoals.id,
    orgId: threadGoals.orgId,
    ownerUserId: threadGoals.ownerUserId,
    agentId: threadGoals.agentId,
    chatThreadId: threadGoals.chatThreadId,
    status: threadGoals.status,
    objective: threadGoals.objective,
    objectiveBrief: threadGoals.objectiveBrief,
    autonomyBudget: rolloutCompatibleAutonomyBudgetColumn(
      autonomyBudgetAvailable,
      threadGoals.autonomyBudget,
    ),
    createdAt: threadGoals.createdAt,
    updatedAt: threadGoals.updatedAt,
  };
}

export function rolloutCompatibleWorkflowAutomationColumns(
  autonomyBudgetAvailable: boolean,
) {
  return {
    id: zeroWorkflowAutomations.id,
    orgId: zeroWorkflowAutomations.orgId,
    workflowId: zeroWorkflowAutomations.workflowId,
    ownerUserId: zeroWorkflowAutomations.ownerUserId,
    kind: zeroWorkflowAutomations.kind,
    eventType: zeroWorkflowAutomations.eventType,
    eventConfig: zeroWorkflowAutomations.eventConfig,
    scheduleType: zeroWorkflowAutomations.scheduleType,
    cronExpression: zeroWorkflowAutomations.cronExpression,
    intervalSeconds: zeroWorkflowAutomations.intervalSeconds,
    atTime: zeroWorkflowAutomations.atTime,
    timezone: zeroWorkflowAutomations.timezone,
    enabled: zeroWorkflowAutomations.enabled,
    nextRunAt: zeroWorkflowAutomations.nextRunAt,
    lastRunAt: zeroWorkflowAutomations.lastRunAt,
    lastRunId: zeroWorkflowAutomations.lastRunId,
    consecutiveFailures: zeroWorkflowAutomations.consecutiveFailures,
    autonomyBudget: rolloutCompatibleAutonomyBudgetColumn(
      autonomyBudgetAvailable,
      zeroWorkflowAutomations.autonomyBudget,
    ),
    createdAt: zeroWorkflowAutomations.createdAt,
    updatedAt: zeroWorkflowAutomations.updatedAt,
  };
}

function rolloutLegacyThreadGoalColumns() {
  return {
    id: rolloutLegacyThreadGoals.id,
    orgId: rolloutLegacyThreadGoals.orgId,
    ownerUserId: rolloutLegacyThreadGoals.ownerUserId,
    agentId: rolloutLegacyThreadGoals.agentId,
    chatThreadId: rolloutLegacyThreadGoals.chatThreadId,
    status: rolloutLegacyThreadGoals.status,
    objective: rolloutLegacyThreadGoals.objective,
    objectiveBrief: rolloutLegacyThreadGoals.objectiveBrief,
    autonomyBudget: sql`${INITIAL_AUTONOMY_BUDGET}::integer`.mapWith(
      pgIntegerDecoder,
    ),
    createdAt: rolloutLegacyThreadGoals.createdAt,
    updatedAt: rolloutLegacyThreadGoals.updatedAt,
  };
}

function rolloutLegacyWorkflowAutomationColumns() {
  return {
    id: rolloutLegacyWorkflowAutomations.id,
    orgId: rolloutLegacyWorkflowAutomations.orgId,
    workflowId: rolloutLegacyWorkflowAutomations.workflowId,
    ownerUserId: rolloutLegacyWorkflowAutomations.ownerUserId,
    kind: rolloutLegacyWorkflowAutomations.kind,
    eventType: rolloutLegacyWorkflowAutomations.eventType,
    eventConfig: rolloutLegacyWorkflowAutomations.eventConfig,
    scheduleType: rolloutLegacyWorkflowAutomations.scheduleType,
    cronExpression: rolloutLegacyWorkflowAutomations.cronExpression,
    intervalSeconds: rolloutLegacyWorkflowAutomations.intervalSeconds,
    atTime: rolloutLegacyWorkflowAutomations.atTime,
    timezone: rolloutLegacyWorkflowAutomations.timezone,
    enabled: rolloutLegacyWorkflowAutomations.enabled,
    nextRunAt: rolloutLegacyWorkflowAutomations.nextRunAt,
    lastRunAt: rolloutLegacyWorkflowAutomations.lastRunAt,
    lastRunId: rolloutLegacyWorkflowAutomations.lastRunId,
    consecutiveFailures: rolloutLegacyWorkflowAutomations.consecutiveFailures,
    autonomyBudget: sql`${INITIAL_AUTONOMY_BUDGET}::integer`.mapWith(
      pgIntegerDecoder,
    ),
    createdAt: rolloutLegacyWorkflowAutomations.createdAt,
    updatedAt: rolloutLegacyWorkflowAutomations.updatedAt,
  };
}

export async function insertRolloutCompatibleZeroRun(
  db: Pick<Db, "insert">,
  values: typeof zeroRuns.$inferInsert,
  autonomyBudgetAvailable: boolean,
): Promise<void> {
  if (autonomyBudgetAvailable) {
    await db.insert(zeroRuns).values(values);
    return;
  }
  await db.insert(rolloutLegacyZeroRuns).values(values);
}

export async function insertRolloutCompatibleThreadGoal(
  db: Pick<Db, "insert">,
  values: typeof threadGoals.$inferInsert,
  autonomyBudgetAvailable: boolean,
): Promise<typeof threadGoals.$inferSelect | undefined> {
  if (autonomyBudgetAvailable) {
    const [row] = await db
      .insert(threadGoals)
      .values(values)
      .returning(rolloutCompatibleThreadGoalColumns(true));
    return row;
  }
  const [row] = await db
    .insert(rolloutLegacyThreadGoals)
    .values(values)
    .returning(rolloutLegacyThreadGoalColumns());
  return row;
}

export async function insertRolloutCompatibleWorkflowAutomation(
  db: Db,
  values: typeof zeroWorkflowAutomations.$inferInsert,
  autonomyBudgetAvailable?: boolean,
): Promise<typeof zeroWorkflowAutomations.$inferSelect | undefined> {
  const schemaAvailable =
    autonomyBudgetAvailable ?? (await autonomyBudgetSchemaAvailable(db));
  if (schemaAvailable) {
    const [row] = await db
      .insert(zeroWorkflowAutomations)
      .values(values)
      .returning(rolloutCompatibleWorkflowAutomationColumns(true));
    return row;
  }
  const [row] = await db
    .insert(rolloutLegacyWorkflowAutomations)
    .values(values)
    .returning(rolloutLegacyWorkflowAutomationColumns());
  return row;
}
