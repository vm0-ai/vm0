ALTER TABLE "chat_automation_context" ADD COLUMN "workflow_name" text;--> statement-breakpoint
ALTER TABLE "chat_automation_context" ADD COLUMN "event_type" text;--> statement-breakpoint
ALTER TABLE "chat_automation_context" ADD COLUMN "event_payload" jsonb;