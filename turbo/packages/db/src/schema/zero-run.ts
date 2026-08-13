import {
  type AnyPgColumn,
  pgTable,
  uuid,
  varchar,
  text,
  index,
  timestamp,
  integer,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { agentRuns } from "./agent-run";
import { chatThreads } from "./chat-thread";
import { zeroWorkflowAutomations } from "./zero-workflow";
import { threadGoals } from "./thread-goal";

/**
 * Zero Runs table
 * Stores Zero-specific run metadata (trigger source, Workflow provenance) as first-class columns.
 * PK is the agent_runs.id — extends agent_runs with Zero-layer context.
 */
export const zeroRuns = pgTable(
  "zero_runs",
  {
    id: uuid("id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    triggerSource: varchar("trigger_source", { length: 20 }).notNull(),
    autonomyBudget: integer("autonomy_budget").notNull().default(10),
    // Canonical run provenance for the Automation that started this run.
    workflowAutomationId: uuid("workflow_automation_id").references(
      (): AnyPgColumn => {
        return zeroWorkflowAutomations.id;
      },
      { onDelete: "set null" },
    ),
    // Run provenance for autonomous thread-goal continuation.
    goalId: uuid("goal_id").references(
      (): AnyPgColumn => {
        return threadGoals.id;
      },
      { onDelete: "set null" },
    ),
    // Model provider and selected model — zero-layer concerns moved from agent_runs
    modelProvider: varchar("model_provider", { length: 100 }),
    modelProviderId: uuid("model_provider_id"),
    modelProviderCredentialScope: varchar("model_provider_credential_scope", {
      length: 20,
    }),
    selectedModel: varchar("selected_model", { length: 255 }),
    codexServiceTier: varchar("codex_service_tier", {
      length: 20,
    }).$type<CodexServiceTier>(),
    /**
     * Built-in video model resolved when this run started. Snapshotted rather
     * than read live from the thread so changing the thread pin mid-run cannot
     * change what the in-flight run generates.
     */
    selectedVideoModel: varchar("selected_video_model", { length: 255 }),
    // Chat thread this run belongs to (null for non-chat triggers like telegram)
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    // First-assistant timing origin. Concurrency-queued runs leave this null
    // until promotion supplies the same start used by runner telemetry.
    apiStartedAt: timestamp("api_started_at"),
    firstAssistantEventAcknowledgedAt: timestamp(
      "first_assistant_event_acknowledged_at",
    ),
    // Brief AI-generated summary of what the run did (≤50 words)
    summary: text("summary"),
    // Brief source context for trigger-fired workflow runs, shown in chat.
    triggerBrief: text("trigger_brief"),
  },
  (table) => {
    return [
      index("idx_zero_runs_chat_thread_id")
        .on(table.chatThreadId)
        .where(sql`chat_thread_id IS NOT NULL`),
      index("idx_zero_runs_workflow_automation")
        .on(table.workflowAutomationId)
        .where(sql`workflow_automation_id IS NOT NULL`),
      index("idx_zero_runs_goal")
        .on(table.goalId)
        .where(sql`goal_id IS NOT NULL`),
      check(
        "zero_runs_autonomy_budget_check",
        sql`${table.autonomyBudget} BETWEEN 0 AND 10`,
      ),
    ];
  },
);
