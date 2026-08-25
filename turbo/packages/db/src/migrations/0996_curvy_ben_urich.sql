ALTER TABLE "chat_event_snapshots" DROP CONSTRAINT "chat_event_snapshots_object_key_unique";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
DROP INDEX "chat_event_snapshots_thread_version_unique";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "chat_tool_activity_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD COLUMN "projection" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_event_snapshots_object_key_idx" ON "chat_event_snapshots" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_snapshots_thread_version_projection_unique" ON "chat_event_snapshots" USING btree ("chat_thread_id","archive_schema_version","projection");--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD CONSTRAINT "chat_event_snapshots_projection_check" CHECK ("chat_event_snapshots"."projection" IN ('full', 'tool-redacted'));--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_output_tool_payload_check" CHECK ("chat_events"."event_type" <> 'output.tool'
          OR (
            "chat_events"."payload" IS NOT NULL
            AND jsonb_typeof("chat_events"."payload") = 'object'
            AND "chat_events"."payload" ?& ARRAY[
              'toolUseId',
              'action',
              'status',
              'summary'
            ]
            AND (
              "chat_events"."payload" -
              'toolUseId' -
              'action' -
              'status' -
              'summary'
            ) = '{}'::jsonb
            AND jsonb_typeof("chat_events"."payload" -> 'toolUseId') = 'string'
            AND jsonb_typeof("chat_events"."payload" -> 'action') = 'string'
            AND "chat_events"."payload" ->> 'action' = ANY (
              ARRAY['run', 'read', 'write', 'edit']
            )
            AND jsonb_typeof("chat_events"."payload" -> 'status') = 'string'
            AND "chat_events"."payload" ->> 'status' = ANY (
              ARRAY['pending', 'success', 'error', 'cancelled']
            )
            AND jsonb_typeof("chat_events"."payload" -> 'summary') = 'string'
            AND position(E'
' IN "chat_events"."payload" ->> 'summary') = 0
            AND position(E'' IN "chat_events"."payload" ->> 'summary') = 0
            AND char_length("chat_events"."payload" ->> 'summary') <= 240
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
          'output.tool',
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