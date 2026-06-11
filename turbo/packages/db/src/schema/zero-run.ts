import {
  type AnyPgColumn,
  pgTable,
  uuid,
  varchar,
  text,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuns } from "./agent-run";
import { agentComposes } from "./agent-compose";
import { chatThreads } from "./chat-thread";
import { automations, automationTriggers } from "./automation";

/**
 * Zero Runs table
 * Stores Zero-specific run metadata (trigger source, schedule) as first-class columns.
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
    // Historical column: pre-cutover schedule fires recorded the (now dropped)
    // zero_agent_schedules id here. New runs carry automation provenance below;
    // the drop migration backfilled automation_id for these legacy rows.
    scheduleId: uuid("schedule_id"),
    // Run provenance: the automation and the trigger that fired this run.
    automationId: uuid("automation_id").references(
      (): AnyPgColumn => {
        return automations.id;
      },
      { onDelete: "set null" },
    ),
    triggerId: uuid("trigger_id").references(
      (): AnyPgColumn => {
        return automationTriggers.id;
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
    // Chat thread this run belongs to (null for non-chat triggers like schedule/telegram)
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    // Brief AI-generated summary of what the run did (≤50 words)
    summary: text("summary"),
  },
  (table) => {
    return [
      index("idx_zero_runs_schedule")
        .on(table.scheduleId)
        .where(sql`schedule_id IS NOT NULL`),
      index("idx_zero_runs_chat_thread_id")
        .on(table.chatThreadId)
        .where(sql`chat_thread_id IS NOT NULL`),
      index("idx_zero_runs_automation")
        .on(table.automationId)
        .where(sql`automation_id IS NOT NULL`),
      index("idx_zero_runs_trigger")
        .on(table.triggerId)
        .where(sql`trigger_id IS NOT NULL`),
    ];
  },
);
