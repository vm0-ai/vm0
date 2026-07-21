DROP TRIGGER "sync_chat_message_queue_automation_id" ON "chat_message_queue";--> statement-breakpoint
DROP FUNCTION "sync_chat_message_queue_automation_id"();--> statement-breakpoint
ALTER TABLE "chat_message_queue" DROP CONSTRAINT "chat_message_queue_trigger_id_zero_workflow_automations_id_fk";
--> statement-breakpoint
DROP INDEX "idx_chat_message_queue_trigger";--> statement-breakpoint
ALTER TABLE "chat_message_queue" DROP COLUMN "trigger_id";
