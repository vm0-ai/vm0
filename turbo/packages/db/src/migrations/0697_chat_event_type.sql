ALTER TABLE "chat_messages" ADD COLUMN "event_type" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_event_type_check" CHECK ("chat_messages"."event_type" IS NULL OR "chat_messages"."event_type" IN (
          'input.prompt',
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
          'goal.changed',
          'usage.recorded'
        )) NOT VALID;
--> statement-breakpoint
-- Keep append-only protection installed throughout the backfill. The temporary
-- function allows only a NULL-to-classified event_type transition and rejects
-- every update that changes any other source field.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_messages'
    AND (to_jsonb(OLD) ->> 'event_type') IS NULL
    AND (to_jsonb(NEW) ->> 'event_type') IS NOT NULL
    AND (to_jsonb(NEW) - 'event_type') = (to_jsonb(OLD) - 'event_type')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
