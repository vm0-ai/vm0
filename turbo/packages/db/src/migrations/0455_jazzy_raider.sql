ALTER TABLE "banking_agent_enablements" ADD COLUMN "allow_automation_runs" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "automation_title" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "automation_snapshot" jsonb;--> statement-breakpoint
-- #17307 phase D2 (add + backfill + dual-write): the automation_* columns on
-- chat_messages and allow_automation_runs on banking_agent_enablements
-- supersede the schedule_* trio and allow_scheduled_runs. Backfill copies the
-- old column values into the new columns; application code dual-writes both
-- sets until the old columns drop in the final phase. Both statements are
-- idempotent so rerunning this migration is a no-op.
UPDATE "chat_messages" SET "automation_id" = "schedule_id", "automation_title" = "schedule_title", "automation_snapshot" = "schedule_snapshot" WHERE ("schedule_id" IS NOT NULL OR "schedule_title" IS NOT NULL OR "schedule_snapshot" IS NOT NULL) AND "automation_id" IS NULL AND "automation_title" IS NULL AND "automation_snapshot" IS NULL;--> statement-breakpoint
UPDATE "banking_agent_enablements" SET "allow_automation_runs" = "allow_scheduled_runs" WHERE "allow_automation_runs" <> "allow_scheduled_runs";
