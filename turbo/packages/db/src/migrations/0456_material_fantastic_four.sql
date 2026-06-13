DROP INDEX "idx_zero_runs_schedule";--> statement-breakpoint
ALTER TABLE "banking_agent_enablements" DROP COLUMN "allow_scheduled_runs";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "schedule_id";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "schedule_title";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "schedule_snapshot";--> statement-breakpoint
ALTER TABLE "zero_runs" DROP COLUMN "schedule_id";