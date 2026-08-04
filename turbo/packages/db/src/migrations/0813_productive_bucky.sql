ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'chat_events_reject_update'
      AND "tgenabled" <> 'D'
  ) THEN
    RAISE EXCEPTION 'chat_events append-only trigger must be enabled';
  END IF;
END;
$$;--> statement-breakpoint
-- Keep append-only protection installed while narrowly permitting only the
-- browser lifecycle event rename. Updates to every other field and table stay
-- rejected throughout the backfill.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND (
      (OLD."event_type" = 'browser.started' AND NEW."event_type" = 'browser.open')
      OR (OLD."event_type" = 'browser.stopped' AND NEW."event_type" = 'browser.close')
    )
    AND (to_jsonb(NEW) - 'event_type') = (to_jsonb(OLD) - 'event_type')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
UPDATE "chat_events"
SET "event_type" = CASE
  WHEN "event_type" = 'browser.started' THEN 'browser.open'
  WHEN "event_type" = 'browser.stopped' THEN 'browser.close'
  ELSE "event_type"
END
WHERE "event_type" IN ('browser.started', 'browser.stopped');--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
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
          'browser.open',
          'browser.close',
          'goal.changed',
          'usage.recorded'
        ));
