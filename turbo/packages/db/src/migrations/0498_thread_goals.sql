CREATE TABLE "thread_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"objective" text NOT NULL,
	"objective_brief" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "thread_goals_status_check" CHECK (status IN ('active', 'paused', 'blocked', 'complete'))
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_schedule_config_check";--> statement-breakpoint
DELETE FROM "chat_messages"
WHERE "role" = 'assistant'
	AND "run_event_id" IN (
		'goal-workflow:active',
		'goal-workflow:inactive',
		'goal-trigger:active',
		'goal-trigger:inactive'
	);--> statement-breakpoint
DELETE FROM "zero_workflow_triggers"
WHERE "event_type" = 'thread-idle'
	OR "workflow_id" IN (
		SELECT "id"
		FROM "zero_workflows"
		WHERE "type" = 'goal'
	);--> statement-breakpoint
DELETE FROM "zero_workflows"
WHERE "type" = 'goal';--> statement-breakpoint
DROP INDEX "idx_zero_workflow_triggers_thread_idle_thread_unique";--> statement-breakpoint
DROP INDEX "idx_zero_workflows_public_agent_name_unique";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "goal_event" jsonb;--> statement-breakpoint
ALTER TABLE "zero_runs" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "thread_goals" ADD CONSTRAINT "thread_goals_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_goals" ADD CONSTRAINT "thread_goals_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_thread_goals_chat_thread_unique" ON "thread_goals" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_thread_goals_org_owner" ON "thread_goals" USING btree ("org_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_thread_goals_org_status" ON "thread_goals" USING btree ("org_id","status");--> statement-breakpoint
ALTER TABLE "zero_runs" ADD CONSTRAINT "zero_runs_goal_id_thread_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."thread_goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_zero_runs_goal" ON "zero_runs" USING btree ("goal_id") WHERE goal_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflows_public_agent_name_unique" ON "zero_workflows" USING btree ("org_id","agent_id","name") WHERE visibility = 'public';--> statement-breakpoint
ALTER TABLE "zero_workflows" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "zero_workflows" DROP COLUMN "active";--> statement-breakpoint
ALTER TABLE "zero_workflows" DROP COLUMN "preference";--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD CONSTRAINT "zero_workflow_triggers_schedule_config_check" CHECK ((
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
            AND event_type = 'gmail-new-message'
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));
