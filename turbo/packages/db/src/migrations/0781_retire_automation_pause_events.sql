DELETE FROM "chat_events"
WHERE "event_type" IN ('queue.automation_paused', 'queue.automation_resumed');--> statement-breakpoint
DROP INDEX "chat_events_automation_pause_idx";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
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
          'control.interrupt',
          'control.revoke',
          'browser.started',
          'browser.stopped',
          'goal.changed',
          'usage.recorded'
        ));
