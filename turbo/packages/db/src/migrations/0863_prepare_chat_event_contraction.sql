-- Prepare the final chat-event schema contraction after the legacy writer and
-- App client floors have drained. The physical columns remain for the current
-- API's declared row shape; a later release drops them after this API drains.
-- One lock covers the browser rewrite, bridge removal, and constraint change.
LOCK TABLE "chat_events" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

DROP TRIGGER IF EXISTS "canonicalize_legacy_chat_event_insert_0861"
ON "chat_events";--> statement-breakpoint
DROP FUNCTION IF EXISTS "canonicalize_legacy_chat_event_insert_0861"();--> statement-breakpoint
DROP FUNCTION IF EXISTS "is_supported_legacy_followups_0861"(jsonb);--> statement-breakpoint

-- Preserve append-only enforcement while allowing only the exact retired
-- browser lifecycle spelling change. Every other column must remain equal.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND OLD."event_type" IN ('browser.started', 'browser.stopped')
    AND NEW."event_type" = (
      CASE OLD."event_type"
        WHEN 'browser.started' THEN 'browser.open'
        WHEN 'browser.stopped' THEN 'browser.close'
      END
    )
    AND (to_jsonb(NEW) - 'event_type') = (to_jsonb(OLD) - 'event_type')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

UPDATE "chat_events"
SET "event_type" = CASE "event_type"
  WHEN 'browser.started' THEN 'browser.open'
  WHEN 'browser.stopped' THEN 'browser.close'
END
WHERE "event_type" IN ('browser.started', 'browser.stopped');--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events"
    WHERE "event_type" IN ('browser.started', 'browser.stopped')
  ) THEN
    RAISE EXCEPTION 'Retired browser lifecycle event types remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "chat_events" WHERE "event_type" = 'goal.changed'
  ) THEN
    RAISE EXCEPTION 'Retired goal.changed rows remain';
  END IF;
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

ALTER TABLE "chat_events"
DROP CONSTRAINT "chat_events_event_type_check";--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_event_type_check" CHECK (
  "chat_events"."event_type" IN (
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
  )
);
