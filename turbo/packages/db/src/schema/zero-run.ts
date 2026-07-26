import {
  type AnyPgColumn,
  pgTable,
  uuid,
  varchar,
  text,
  index,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuns } from "./agent-run";
import { agentComposes } from "./agent-compose";
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
    // Canonical run provenance for the Automation that started this run.
    workflowAutomationId: uuid("workflow_automation_id").references(
      (): AnyPgColumn => {
        return zeroWorkflowAutomations.id;
      },
      { onDelete: "set null" },
    ),
    // Stable grouping key copied from workflow automations/goals for chat
    // rendering of repeated automated runs.
    runGroupId: uuid("run_group_id"),
    // Run provenance for autonomous thread-goal continuation.
    goalId: uuid("goal_id").references(
      (): AnyPgColumn => {
        return threadGoals.id;
      },
      { onDelete: "set null" },
    ),
    // References agent_composes.id of the agent that triggered this run (agent-to-agent delegation)
    triggerAgentId: uuid("trigger_agent_id").references(
      () => {
        return agentComposes.id;
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
    firstAssistantMessageAcknowledgedAt: timestamp(
      "first_assistant_message_acknowledged_at",
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
      index("idx_zero_runs_run_group")
        .on(table.runGroupId)
        .where(sql`run_group_id IS NOT NULL`),
      index("idx_zero_runs_goal")
        .on(table.goalId)
        .where(sql`goal_id IS NOT NULL`),
    ];
  },
);
