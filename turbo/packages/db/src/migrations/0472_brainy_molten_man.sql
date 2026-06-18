CREATE TABLE "zero_workflow_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"agent_id" uuid,
	"owner_user_id" text NOT NULL,
	"schedule_type" varchar(16) NOT NULL,
	"cron_expression" varchar(100),
	"interval_seconds" integer,
	"at_time" timestamp,
	"timezone" varchar(50) DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"chat_thread_id" uuid,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"last_run_id" uuid,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "zero_workflow_triggers_schedule_config_check" CHECK ((schedule_type = 'cron' AND cron_expression IS NOT NULL AND interval_seconds IS NULL AND at_time IS NULL)
          OR (schedule_type = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)
          OR (schedule_type = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL))
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD CONSTRAINT "zero_workflow_triggers_workflow_id_zero_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."zero_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD CONSTRAINT "zero_workflow_triggers_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD CONSTRAINT "zero_workflow_triggers_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_triggers_workflow" ON "zero_workflow_triggers" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_triggers_org" ON "zero_workflow_triggers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_triggers_chat_thread" ON "zero_workflow_triggers" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_triggers_next_run" ON "zero_workflow_triggers" USING btree ("next_run_at") WHERE enabled = true;