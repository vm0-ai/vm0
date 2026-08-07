ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_goal_open_content_check" CHECK ("chat_events"."event_type" <> 'goal.open'
          OR (
            "chat_events"."content" IS NOT NULL
            AND "chat_events"."content" = btrim("chat_events"."content")
            AND char_length("chat_events"."content") > 0
          ));--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_goal_close_content_check" CHECK ("chat_events"."event_type" <> 'goal.close' OR "chat_events"."content" IS NULL);--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_goal_marker_payload_check" CHECK ("chat_events"."event_type" NOT IN ('goal.open', 'goal.close')
          OR (
            "chat_events"."run_id" IS NULL
            AND "chat_events"."usage_payload" IS NULL
            AND "chat_events"."revokes_event_id" IS NULL
            AND "chat_events"."interrupts_run_id" IS NULL
            AND "chat_events"."run_group_id" IS NULL
            AND "chat_events"."context_type" IS NULL
            AND "chat_events"."context_id" IS NULL
            AND "chat_events"."user_message" IS NULL
            AND "chat_events"."thinking" IS NULL
            AND "chat_events"."error" IS NULL
            AND "chat_events"."active_input_sequence" IS NULL
            AND "chat_events"."run_event_sequence_number" IS NULL
            AND "chat_events"."run_event_id" IS NULL
            AND "chat_events"."goal_event" IS NULL
            AND "chat_events"."attach_files" IS NULL
            AND "chat_events"."generation_template" IS NULL
            AND "chat_events"."recommended_followups" IS NULL
          ));--> statement-breakpoint
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
          -- Retired physical values still written by the pre-cleanup API while
          -- it drains. Narrow this list to open/close in a later release, once
          -- that API is gone and the rows have been backfilled again.
          'browser.started',
          'browser.stopped',
          'goal.open',
          'goal.close',
          'goal.changed',
          'usage.recorded'
        ));