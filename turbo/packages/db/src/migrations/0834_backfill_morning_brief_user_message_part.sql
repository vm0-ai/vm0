-- Custom SQL migration file, put your code below! --
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
-- expected Morning Brief user_message part to be appended. Every other column
-- and every other user_message transition remain immutable.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
DECLARE
  expected_user_message jsonb;
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND OLD."event_type" = 'input.prompt'
    AND OLD."context_type" = 'morning_brief'
    AND OLD."context_id" IS NOT NULL
    AND NEW."user_message" IS DISTINCT FROM OLD."user_message"
    AND (to_jsonb(NEW) - 'user_message')
      = (to_jsonb(OLD) - 'user_message')
  THEN
    SELECT jsonb_set(
      OLD."user_message",
      '{parts}',
      (OLD."user_message" -> 'parts') || jsonb_build_array(
        jsonb_build_object(
          'type', 'morning_brief',
          'briefDate', "delivery"."brief_date"
        )
      ),
      false
    )
    INTO expected_user_message
    FROM "chat_morning_brief_context" AS "context"
    INNER JOIN "morning_brief_deliveries" AS "delivery"
      ON "delivery"."id" = "context"."delivery_id"
    WHERE "context"."id" = OLD."context_id"
      AND "context"."chat_thread_id" = OLD."chat_thread_id";

    IF expected_user_message IS NOT NULL
      AND NEW."user_message" = expected_user_message
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

UPDATE "chat_events" AS "target"
SET "user_message" = jsonb_set(
  "target"."user_message",
  '{parts}',
  ("target"."user_message" -> 'parts') || jsonb_build_array(
    jsonb_build_object(
      'type', 'morning_brief',
      'briefDate', "delivery"."brief_date"
    )
  ),
  false
)
FROM "chat_morning_brief_context" AS "context"
INNER JOIN "morning_brief_deliveries" AS "delivery"
  ON "delivery"."id" = "context"."delivery_id"
WHERE "target"."event_type" = 'input.prompt'
  AND "target"."context_type" = 'morning_brief'
  AND "target"."context_id" = "context"."id"
  AND "target"."chat_thread_id" = "context"."chat_thread_id"
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements("target"."user_message" -> 'parts') AS "part"
    WHERE "part" ->> 'type' = 'morning_brief'
  );--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "event"
    LEFT JOIN "chat_morning_brief_context" AS "context"
      ON "context"."id" = "event"."context_id"
      AND "context"."chat_thread_id" = "event"."chat_thread_id"
    LEFT JOIN "morning_brief_deliveries" AS "delivery"
      ON "delivery"."id" = "context"."delivery_id"
    WHERE "event"."event_type" = 'input.prompt'
      AND "event"."context_type" = 'morning_brief'
      AND (
        "delivery"."id" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements("event"."user_message" -> 'parts') AS "part"
          WHERE "part" = jsonb_build_object(
            'type', 'morning_brief',
            'briefDate', "delivery"."brief_date"
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Morning Brief chat_events still lack the expected user_message part';
  END IF;
END;
$$;
