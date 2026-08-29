ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_output_tool_payload_check";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
DROP INDEX "chat_events_output_tool_thread_seq_idx";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "chat_tool_activity_enabled";--> statement-breakpoint
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
          'browser.open',
          'browser.close',
          'goal.open',
          'goal.close',
          'usage.recorded'
        ));
