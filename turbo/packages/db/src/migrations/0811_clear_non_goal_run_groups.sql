-- Custom SQL migration file
-- vm0:non-transactional
-- Existing automation runs used run_group_id as a presentation hint. Goal
-- continuations are now the only grouped runs, so clear every other value in
-- small transactions while normal readers and writers continue.

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

-- The draining release still writes automation ids into run_group_id. Install
-- compatibility bridges before cleanup so writes racing the backfill and
-- writes arriving after it both satisfy the goal-only storage contract.
CREATE OR REPLACE FUNCTION "bridge_goal_only_zero_run_group_0810"()
RETURNS trigger AS $$
BEGIN
  NEW."run_group_id" := NEW."goal_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.zero_runs'::regclass
      AND "tgname" = 'bridge_goal_only_zero_run_group_0810'
      AND NOT "tgisinternal"
  ) THEN
    CREATE TRIGGER "bridge_goal_only_zero_run_group_0810"
    BEFORE INSERT OR UPDATE OF "run_group_id", "goal_id" ON "zero_runs"
    FOR EACH ROW
    EXECUTE FUNCTION "bridge_goal_only_zero_run_group_0810"();
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "bridge_goal_only_chat_event_run_group_0810"()
RETURNS trigger AS $$
BEGIN
  IF NEW."run_group_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "thread_goals" AS "goal"
      WHERE "goal"."id" = NEW."run_group_id"
        AND "goal"."chat_thread_id" = NEW."chat_thread_id"
    )
  THEN
    NEW."run_group_id" := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_trigger"
    WHERE "tgrelid" = 'public.chat_events'::regclass
      AND "tgname" = 'bridge_goal_only_chat_event_run_group_0810'
      AND NOT "tgisinternal"
  ) THEN
    CREATE TRIGGER "bridge_goal_only_chat_event_run_group_0810"
    BEFORE INSERT ON "chat_events"
    FOR EACH ROW
    EXECUTE FUNCTION "bridge_goal_only_chat_event_run_group_0810"();
  END IF;
END;
$$;--> statement-breakpoint

-- Keep append-only protection installed while narrowly permitting only a
-- non-goal run_group_id to be cleared. Every other column remains immutable.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND OLD."run_group_id" IS NOT NULL
    AND NEW."run_group_id" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "thread_goals" AS "goal"
      WHERE "goal"."id" = OLD."run_group_id"
        AND "goal"."chat_thread_id" = OLD."chat_thread_id"
    )
    AND (to_jsonb(NEW) - 'run_group_id')
      = (to_jsonb(OLD) - 'run_group_id')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE PROCEDURE "clear_non_goal_zero_run_groups_0810"()
LANGUAGE plpgsql AS $$
DECLARE
  batch_last_id uuid;
  last_id uuid;
BEGIN
  LOOP
    batch_last_id := NULL;

    WITH batch AS (
      SELECT "candidate"."id"
      FROM "zero_runs" AS "candidate"
      WHERE (last_id IS NULL OR "candidate"."id" > last_id)
        AND "candidate"."run_group_id" IS NOT NULL
        AND "candidate"."goal_id" IS NULL
      ORDER BY "candidate"."id"
      LIMIT 10000
      FOR UPDATE OF "candidate" SKIP LOCKED
    ), updated AS (
      UPDATE "zero_runs" AS "target"
      SET "run_group_id" = NULL
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

CALL "clear_non_goal_zero_run_groups_0810"();--> statement-breakpoint
DROP PROCEDURE IF EXISTS "clear_non_goal_zero_run_groups_0810"();--> statement-breakpoint

CREATE OR REPLACE PROCEDURE "clear_non_goal_chat_event_run_groups_0810"()
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
        AND "candidate"."run_group_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "thread_goals" AS "goal"
          WHERE "goal"."id" = "candidate"."run_group_id"
            AND "goal"."chat_thread_id" = "candidate"."chat_thread_id"
        )
      ORDER BY "candidate"."id"
      LIMIT 10000
      FOR UPDATE OF "candidate" SKIP LOCKED
    ), updated AS (
      UPDATE "chat_events" AS "target"
      SET "run_group_id" = NULL
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

CALL "clear_non_goal_chat_event_run_groups_0810"();--> statement-breakpoint
DROP PROCEDURE IF EXISTS "clear_non_goal_chat_event_run_groups_0810"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "zero_runs"
    WHERE "run_group_id" IS NOT NULL
      AND "goal_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Non-goal zero_runs still have run_group_id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "event"
    WHERE "event"."run_group_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "thread_goals" AS "goal"
        WHERE "goal"."id" = "event"."run_group_id"
          AND "goal"."chat_thread_id" = "event"."chat_thread_id"
      )
  ) THEN
    RAISE EXCEPTION 'Non-goal chat_events still have run_group_id';
  END IF;
END;
$$;
