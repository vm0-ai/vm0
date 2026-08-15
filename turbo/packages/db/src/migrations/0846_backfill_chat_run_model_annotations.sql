-- vm0:non-transactional
-- Backfill immutable run-model provenance without a table-wide update. Each
-- batch locks at most 500 eligible chat_events rows, skips rows already locked
-- by another transaction, commits before continuing, and pauses between
-- batches to keep foreground write latency stable.

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

-- Keep append-only protection installed while narrowly permitting the exact
-- model part derived from zero_runs.selected_model. Every other column and
-- every other user_message transition remain immutable.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
DECLARE
  expected_user_message jsonb;
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND OLD."run_id" IS NOT NULL
    AND OLD."user_message" IS NOT NULL
    AND jsonb_typeof(OLD."user_message" -> 'parts') = 'array'
    AND NEW."user_message" IS DISTINCT FROM OLD."user_message"
    AND (to_jsonb(NEW) - 'user_message')
      = (to_jsonb(OLD) - 'user_message')
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(OLD."user_message" -> 'parts') AS "part"
      WHERE "part" ->> 'type' = 'model'
    )
  THEN
    SELECT jsonb_set(
      OLD."user_message",
      '{parts}',
      (OLD."user_message" -> 'parts') || jsonb_build_array(
        jsonb_build_object(
          'type', 'model',
          'selectedModel', "run"."selected_model"
        )
      ),
      false
    )
    INTO expected_user_message
    FROM "zero_runs" AS "run"
    WHERE "run"."id" = OLD."run_id"
      AND "run"."selected_model" IS NOT NULL
      AND "run"."selected_model" <> '';

    IF expected_user_message IS NOT NULL
      AND NEW."user_message" = expected_user_message
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE PROCEDURE "backfill_chat_run_model_annotations_0846"()
LANGUAGE plpgsql AS $$
DECLARE
  batch_last_id uuid;
  last_id uuid;
BEGIN
  LOOP
    batch_last_id := NULL;

    WITH batch AS (
      SELECT
        "candidate"."id",
        "run"."selected_model"
      FROM "chat_events" AS "candidate"
      INNER JOIN "zero_runs" AS "run"
        ON "run"."id" = "candidate"."run_id"
      WHERE (last_id IS NULL OR "candidate"."id" > last_id)
        AND "candidate"."user_message" IS NOT NULL
        AND jsonb_typeof("candidate"."user_message" -> 'parts') = 'array'
        AND "run"."selected_model" IS NOT NULL
        AND "run"."selected_model" <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            "candidate"."user_message" -> 'parts'
          ) AS "part"
          WHERE "part" ->> 'type' = 'model'
        )
      ORDER BY "candidate"."id"
      LIMIT 500
      FOR UPDATE OF "candidate" SKIP LOCKED
    ), updated AS (
      UPDATE "chat_events" AS "target"
      SET "user_message" = jsonb_set(
        "target"."user_message",
        '{parts}',
        ("target"."user_message" -> 'parts') || jsonb_build_array(
          jsonb_build_object(
            'type', 'model',
            'selectedModel', batch."selected_model"
          )
        ),
        false
      )
      FROM batch
      WHERE "target"."id" = batch."id"
      RETURNING "target"."id"
    )
    SELECT "updated"."id"
    INTO batch_last_id
    FROM updated
    ORDER BY "updated"."id" DESC
    LIMIT 1;

    COMMIT;

    IF batch_last_id IS NOT NULL THEN
      last_id := batch_last_id;
      PERFORM pg_sleep(0.05);
      CONTINUE;
    END IF;

    -- A prior pass may have skipped a concurrently locked row below last_id.
    -- Restart only while eligible work remains, rather than silently leaving
    -- a partial backfill.
    IF EXISTS (
      SELECT 1
      FROM "chat_events" AS "candidate"
      INNER JOIN "zero_runs" AS "run"
        ON "run"."id" = "candidate"."run_id"
      WHERE "candidate"."user_message" IS NOT NULL
        AND jsonb_typeof("candidate"."user_message" -> 'parts') = 'array'
        AND "run"."selected_model" IS NOT NULL
        AND "run"."selected_model" <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            "candidate"."user_message" -> 'parts'
          ) AS "part"
          WHERE "part" ->> 'type' = 'model'
        )
    ) THEN
      last_id := NULL;
      PERFORM pg_sleep(0.25);
      CONTINUE;
    END IF;

    EXIT;
  END LOOP;
END;
$$;--> statement-breakpoint

CALL "backfill_chat_run_model_annotations_0846"();--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_chat_run_model_annotations_0846"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "candidate"
    INNER JOIN "zero_runs" AS "run"
      ON "run"."id" = "candidate"."run_id"
    WHERE "candidate"."user_message" IS NOT NULL
      AND jsonb_typeof("candidate"."user_message" -> 'parts') = 'array'
      AND "run"."selected_model" IS NOT NULL
      AND "run"."selected_model" <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          "candidate"."user_message" -> 'parts'
        ) AS "part"
        WHERE "part" ->> 'type' = 'model'
      )
  ) THEN
    RAISE EXCEPTION 'Eligible chat_events still lack a run model annotation';
  END IF;
END;
$$;
