ALTER TABLE "automation_triggers" ADD COLUMN "cron_expression" varchar(100);--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD COLUMN "at_time" timestamp;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD COLUMN "interval_seconds" integer;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD COLUMN "timezone" varchar(50) DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD COLUMN "next_run_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD COLUMN "last_run_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD COLUMN "last_run_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD COLUMN "retry_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "source_schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_last_run_id_agent_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_automation_triggers_next_run" ON "automation_triggers" USING btree ("next_run_at") WHERE enabled = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automations_source_schedule" ON "automations" USING btree ("source_schedule_id");