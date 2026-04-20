ALTER TABLE "agent_schedules" ADD COLUMN "trigger_type" varchar(20) DEFAULT 'cron' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "interval_seconds" integer;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "agent_schedules" SET "trigger_type" = 'once' WHERE "at_time" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" DROP CONSTRAINT IF EXISTS "trigger_check";--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "trigger_check" CHECK (
  (trigger_type = 'cron' AND cron_expression IS NOT NULL AND at_time IS NULL AND interval_seconds IS NULL) OR
  (trigger_type = 'once' AND cron_expression IS NULL AND at_time IS NOT NULL AND interval_seconds IS NULL) OR
  (trigger_type = 'loop' AND cron_expression IS NULL AND at_time IS NULL AND interval_seconds IS NOT NULL)
);
