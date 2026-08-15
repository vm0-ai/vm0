-- Custom SQL migration file, put your code below! --
-- vm0:non-transactional
-- Custom SQL migration file
-- The goal-context writer release was fully deployed and observed before this
-- migration. New goal events now store null context pointers, so no insert
-- bridge is needed while the historical pointers are cleared.

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

-- Keep append-only protection installed while narrowly permitting only a
-- goal context pointer to be cleared. Every other column remains immutable.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND OLD."context_type" = 'goal'
    AND OLD."context_id" IS NOT NULL
    AND NEW."context_type" IS NULL
    AND NEW."context_id" IS NULL
    AND (to_jsonb(NEW) - 'context_type' - 'context_id')
      = (to_jsonb(OLD) - 'context_type' - 'context_id')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE PROCEDURE "clear_goal_chat_event_context_pointers_0824"()
LANGUAGE plpgsql AS $$
DECLARE
  batch_last_id uuid;
  last_id uuid;
BEGIN
  LOOP
    batch_last_id := NULL;

    WITH batch AS (
      SELECT "candidate"."id"
      FROM "chat_events" AS "candidate"
      WHERE (last_id IS NULL OR "candidate"."id" > last_id)
        AND "candidate"."context_type" = 'goal'
      ORDER BY "candidate"."id"
      LIMIT 10000
      FOR UPDATE OF "candidate" SKIP LOCKED
    ), updated AS (
      UPDATE "chat_events" AS "target"
      SET "context_type" = NULL,
          "context_id" = NULL
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
    EXIT WHEN batch_last_id IS NULL;
    last_id := batch_last_id;
  END LOOP;
END;
$$;--> statement-breakpoint

CALL "clear_goal_chat_event_context_pointers_0824"();--> statement-breakpoint
DROP PROCEDURE IF EXISTS "clear_goal_chat_event_context_pointers_0824"();--> statement-breakpoint

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
    WHERE "context_type" = 'goal'
  ) THEN
    RAISE EXCEPTION 'Goal chat_events still have context pointers';
  END IF;
END;
$$;
