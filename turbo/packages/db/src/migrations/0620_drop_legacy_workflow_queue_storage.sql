DROP TABLE "zero_workflow_queue_events" CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_user_automation_threads" DROP COLUMN "queue_paused_at";--> statement-breakpoint
ALTER TABLE "workflow_user_automation_threads" DROP COLUMN "pause_reason";