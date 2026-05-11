ALTER TABLE "remote_agent_device_codes" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_agent_device_codes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_agent_jobs" ALTER COLUMN "backend" DROP NOT NULL;
