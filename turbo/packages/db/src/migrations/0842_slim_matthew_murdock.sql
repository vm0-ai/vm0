ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_input_user_message_check";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_input_content_check";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_input_context_type_check";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_event_type_check" CHECK ("chat_events"."event_type" IN (
          'input.prompt',
          'input.automation',
          'input.goal',
          'input.budget',
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
        ));--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_input_user_message_check" CHECK ("chat_events"."event_type" NOT IN ('input.prompt', 'input.budget', 'input.rejected')
          OR "chat_events"."user_message" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_input_content_check" CHECK ("chat_events"."event_type" NOT IN ('input.prompt', 'input.budget', 'input.rejected')
          OR "chat_events"."content" IS NULL);--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_input_context_type_check" CHECK ("chat_events"."event_type" NOT IN ('input.prompt', 'input.automation', 'input.goal', 'input.budget')
          OR "chat_events"."context_type" IS NOT NULL);