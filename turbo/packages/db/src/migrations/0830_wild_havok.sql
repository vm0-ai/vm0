CREATE TABLE "chat_agent_run_context" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_chat_thread_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
ALTER TABLE "thread_goals" ADD COLUMN "autonomy_budget" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_runs" ADD COLUMN "autonomy_budget" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD COLUMN "autonomy_budget" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'slack',
          'feishu',
          'teams',
          'telegram',
          'github',
          'agentphone',
          'automation',
          'goal',
          'morning_brief',
          'agent_run'
        ));--> statement-breakpoint
ALTER TABLE "thread_goals" ADD CONSTRAINT "thread_goals_autonomy_budget_check" CHECK ("thread_goals"."autonomy_budget" BETWEEN 0 AND 10);--> statement-breakpoint
ALTER TABLE "zero_runs" ADD CONSTRAINT "zero_runs_autonomy_budget_check" CHECK ("zero_runs"."autonomy_budget" BETWEEN 0 AND 10);--> statement-breakpoint
ALTER TABLE "zero_workflow_automations" ADD CONSTRAINT "zero_workflow_automations_autonomy_budget_check" CHECK ("zero_workflow_automations"."autonomy_budget" BETWEEN 0 AND 10);