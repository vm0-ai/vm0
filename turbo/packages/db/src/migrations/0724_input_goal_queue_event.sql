ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
DROP INDEX "chat_events_pending_queue_idx";--> statement-breakpoint
CREATE INDEX "chat_events_pending_queue_idx" ON "chat_events" USING btree ("chat_thread_id","created_at","id") WHERE "chat_events"."run_id" IS NULL AND "chat_events"."event_type" IN ('input.prompt', 'input.automation', 'input.goal');--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_event_type_check" CHECK ("chat_events"."event_type" IN (
          'input.prompt',
          'input.automation',
          'input.goal',
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
        ));
