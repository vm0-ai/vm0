import {
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Migration 0879_third_marvel_zombies may lag a newly deployed API on the
// DB/API surface for the observed maximum version-skew window of approximately
// 102 minutes. Drizzle inserts every declared column, so standard runs
// temporarily use this pre-expansion column set. Remove it after
// 0879_third_marvel_zombies is deployed everywhere and the API rollback window
// has closed. Follow-up: #26120.
export const zeroRunsBeforeCodexServiceTier = pgTable("zero_runs", {
  id: uuid("id").primaryKey(),
  triggerSource: varchar("trigger_source", { length: 20 }).notNull(),
  autonomyBudget: integer("autonomy_budget").notNull().default(10),
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
  triggerBrief: text("trigger_brief"),
});
