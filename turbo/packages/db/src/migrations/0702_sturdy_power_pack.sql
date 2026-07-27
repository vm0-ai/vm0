ALTER TABLE "chat_messages" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "trigger_source" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "trigger_brief" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "encrypted_params" text;--> statement-breakpoint
CREATE INDEX "chat_messages_input_automation_idx" ON "chat_messages" USING btree ("automation_id") WHERE "chat_messages"."event_type" = 'input.automation';--> statement-breakpoint
CREATE INDEX "chat_messages_pending_queue_idx" ON "chat_messages" USING btree ("chat_thread_id","created_at","id") WHERE "chat_messages"."run_id" IS NULL AND "chat_messages"."event_type" IN ('input.prompt', 'input.automation');--> statement-breakpoint
CREATE INDEX "chat_messages_automation_pause_idx" ON "chat_messages" USING btree ("chat_thread_id","seq_id" DESC NULLS LAST) WHERE "chat_messages"."event_type" IN ('queue.automation_paused', 'queue.automation_resumed');--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_event_type_check_expanded" CHECK ("chat_messages"."event_type" IN (
          'input.prompt',
          'input.automation',
          'input.rejected',
          'output.message',
          'output.error',
          'output.thinking',
          'output.followups',
          'run.queued',
          'run.dequeued',
          'run.completed',
          'run.failed',
          'run.cancelled',
          'queue.automation_paused',
          'queue.automation_resumed',
          'control.interrupt',
          'control.revoke',
          'goal.changed',
          'usage.recorded'
        )) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_messages" VALIDATE CONSTRAINT "chat_messages_event_type_check_expanded";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_event_type_check";--> statement-breakpoint
ALTER TABLE "chat_messages" RENAME CONSTRAINT "chat_messages_event_type_check_expanded" TO "chat_messages_event_type_check";
