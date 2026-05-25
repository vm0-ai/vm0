ALTER TABLE "agent_schedules" ADD COLUMN "notify_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "notify_slack" boolean DEFAULT true NOT NULL;