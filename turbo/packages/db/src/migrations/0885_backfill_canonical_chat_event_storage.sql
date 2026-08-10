-- vm0:non-transactional
-- Backfill the canonical chat event storage introduced by the dual-write
-- release: payload from the legacy leaves, run_id for control.interrupt rows,
-- goal context pointers from run_group_id, and zero_runs.goal_id from
-- run_group_id. The dual-write release was fully deployed and observed before
-- this migration, so every new row already carries the canonical fields and
-- only historical rows are eligible.
--
-- This is a low-lock backfill, not a lock-free one. Each batch takes the
-- normal ROW EXCLUSIVE table lock plus row locks on at most 500 rows, commits
-- independently, and pauses 50ms before the next batch, so normal selects and
-- inserts never wait behind a long transaction. Rows skipped because a
-- concurrent writer held their lock are retried by restart passes until none
-- remain, and the whole migration is safe to rerun after an interruption.

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

-- Fail before touching any data when the legacy and canonical columns
-- disagree. The backfill only fills canonical values that are still NULL; a
-- populated value that contradicts its legacy source has no deterministic
-- resolution and must abort instead of guessing.
DO $$
DECLARE
  conflict_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO conflict_count
  FROM "chat_events"
  WHERE "event_type" = 'control.interrupt'
    AND "run_id" IS NOT NULL
    AND "interrupts_run_id" IS NOT NULL
    AND "run_id" <> "interrupts_run_id";
  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'chat_events has % control.interrupt rows whose run_id conflicts with interrupts_run_id',
      conflict_count;
  END IF;

  SELECT COUNT(*)
  INTO conflict_count
  FROM "chat_events"
  WHERE "run_group_id" IS NOT NULL
    AND (
      ("context_type" IS NOT NULL AND "context_type" <> 'goal')
      OR ("context_id" IS NOT NULL AND "context_id" <> "run_group_id")
    );
  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'chat_events has % goal-grouped rows whose context conflicts with run_group_id',
      conflict_count;
  END IF;

  SELECT COUNT(*)
  INTO conflict_count
  FROM "zero_runs"
  WHERE "run_group_id" IS NOT NULL
    AND "goal_id" IS NOT NULL
    AND "goal_id" <> "run_group_id";
  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'zero_runs has % rows whose goal_id conflicts with run_group_id',
      conflict_count;
  END IF;
END;
$$;--> statement-breakpoint

-- Canonical payload image of one row's legacy leaves, shared by the narrowed
-- append-only trigger, the backfill batches, and the final assertion. A leaf
-- contributes its key exactly when it is SQL NOT NULL; nested JSON nulls
-- inside user_message and usage_payload are preserved verbatim (never
-- jsonb_strip_nulls), and the result is SQL NULL only when every leaf is SQL
-- NULL. This mirrors the dual-write serialization introduced with the payload
-- column.
CREATE OR REPLACE FUNCTION "canonical_chat_event_payload_0885"(
  "event" "chat_events"
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(
    (CASE
      WHEN "event"."content" IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('content', "event"."content")
    END)
    || (CASE
      WHEN "event"."user_message" IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('userMessage', "event"."user_message")
    END)
    || (CASE
      WHEN "event"."thinking" IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('thinking', "event"."thinking")
    END)
    || (CASE
      WHEN "event"."error" IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('error', "event"."error")
    END)
    || (CASE
      WHEN "event"."usage_payload" IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('usage', "event"."usage_payload")
    END),
    '{}'::jsonb
  );
$$;--> statement-breakpoint

-- Keep append-only protection installed while narrowly permitting exactly one
-- transition per row: the deterministic canonical image of its legacy
-- columns. payload may only become the derived payload (or stay put once
-- populated), run_id may only adopt interrupts_run_id on a control.interrupt
-- row that has none, and the goal context pointers may only be completed from
-- run_group_id when the existing context is compatible. Every other column
-- and every other transition remain immutable, so a conflicting row cannot be
-- rewritten even by the backfill itself.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND (to_jsonb(NEW) - 'payload' - 'run_id' - 'context_type' - 'context_id')
      = (to_jsonb(OLD) - 'payload' - 'run_id' - 'context_type' - 'context_id')
    AND NEW."payload" IS NOT DISTINCT FROM COALESCE(
      OLD."payload",
      "canonical_chat_event_payload_0885"(OLD)
    )
    AND NEW."run_id" IS NOT DISTINCT FROM (CASE
      WHEN OLD."event_type" = 'control.interrupt' AND OLD."run_id" IS NULL
      THEN OLD."interrupts_run_id"
      ELSE OLD."run_id"
    END)
    AND NEW."context_type" IS NOT DISTINCT FROM (CASE
      WHEN OLD."run_group_id" IS NOT NULL
        AND (OLD."context_type" IS NULL
          OR (OLD."context_type" = 'goal' AND OLD."context_id" IS NULL))
      THEN 'goal'
      ELSE OLD."context_type"
    END)
    AND NEW."context_id" IS NOT DISTINCT FROM (CASE
      WHEN OLD."run_group_id" IS NOT NULL
        AND (OLD."context_type" IS NULL
          OR (OLD."context_type" = 'goal' AND OLD."context_id" IS NULL))
      THEN OLD."run_group_id"
      ELSE OLD."context_id"
    END)
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE PROCEDURE "backfill_canonical_chat_event_storage_0885"()
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
        AND (
          ("candidate"."payload" IS NULL
            AND ("candidate"."content" IS NOT NULL
              OR "candidate"."user_message" IS NOT NULL
              OR "candidate"."thinking" IS NOT NULL
              OR "candidate"."error" IS NOT NULL
              OR "candidate"."usage_payload" IS NOT NULL))
          OR ("candidate"."event_type" = 'control.interrupt'
            AND "candidate"."run_id" IS NULL
            AND "candidate"."interrupts_run_id" IS NOT NULL)
          OR ("candidate"."run_group_id" IS NOT NULL
            AND ("candidate"."context_type" IS NULL
              OR ("candidate"."context_type" = 'goal'
                AND "candidate"."context_id" IS NULL)))
        )
      ORDER BY "candidate"."id"
      LIMIT 500
      FOR UPDATE OF "candidate" SKIP LOCKED
    ), updated AS (
      UPDATE "chat_events" AS "target"
      SET "payload" = COALESCE(
          "target"."payload",
          "canonical_chat_event_payload_0885"("target")
        ),
        "run_id" = CASE
          WHEN "target"."event_type" = 'control.interrupt'
            AND "target"."run_id" IS NULL
          THEN "target"."interrupts_run_id"
          ELSE "target"."run_id"
        END,
        "context_type" = CASE
          WHEN "target"."run_group_id" IS NOT NULL
            AND ("target"."context_type" IS NULL
              OR ("target"."context_type" = 'goal'
                AND "target"."context_id" IS NULL))
          THEN 'goal'
          ELSE "target"."context_type"
        END,
        "context_id" = CASE
          WHEN "target"."run_group_id" IS NOT NULL
            AND ("target"."context_type" IS NULL
              OR ("target"."context_type" = 'goal'
                AND "target"."context_id" IS NULL))
          THEN "target"."run_group_id"
          ELSE "target"."context_id"
        END
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
      WHERE
        ("candidate"."payload" IS NULL
          AND ("candidate"."content" IS NOT NULL
            OR "candidate"."user_message" IS NOT NULL
            OR "candidate"."thinking" IS NOT NULL
            OR "candidate"."error" IS NOT NULL
            OR "candidate"."usage_payload" IS NOT NULL))
        OR ("candidate"."event_type" = 'control.interrupt'
          AND "candidate"."run_id" IS NULL
          AND "candidate"."interrupts_run_id" IS NOT NULL)
        OR ("candidate"."run_group_id" IS NOT NULL
          AND ("candidate"."context_type" IS NULL
            OR ("candidate"."context_type" = 'goal'
              AND "candidate"."context_id" IS NULL)))
    ) THEN
      last_id := NULL;
      PERFORM pg_sleep(0.25);
      CONTINUE;
    END IF;

    EXIT;
  END LOOP;
END;
$$;--> statement-breakpoint

CALL "backfill_canonical_chat_event_storage_0885"();--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_canonical_chat_event_storage_0885"();--> statement-breakpoint

-- zero_runs has no append-only trigger; the permanent goal-only bridge
-- trigger rewrites run_group_id := goal_id on this update, which is a no-op
-- here because goal_id receives exactly run_group_id. Rows whose goal row no
-- longer exists keep goal_id NULL: that is the same end state the FK's ON
-- DELETE SET NULL produces for dual-written rows, so skipping them is the
-- deterministic canonical outcome, not a guess.
CREATE OR REPLACE PROCEDURE "backfill_zero_run_goal_ids_0885"()
LANGUAGE plpgsql AS $$
DECLARE
  batch_last_id uuid;
  last_id uuid;
BEGIN
  LOOP
    batch_last_id := NULL;

    WITH batch AS (
      SELECT "candidate"."id", "candidate"."run_group_id"
      FROM "zero_runs" AS "candidate"
      WHERE (last_id IS NULL OR "candidate"."id" > last_id)
        AND "candidate"."run_group_id" IS NOT NULL
        AND "candidate"."goal_id" IS NULL
        AND EXISTS (
          SELECT 1
          FROM "thread_goals" AS "goal"
          WHERE "goal"."id" = "candidate"."run_group_id"
        )
      ORDER BY "candidate"."id"
      LIMIT 500
      FOR UPDATE OF "candidate" SKIP LOCKED
    ), updated AS (
      UPDATE "zero_runs" AS "target"
      SET "goal_id" = batch."run_group_id"
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

    IF EXISTS (
      SELECT 1
      FROM "zero_runs" AS "candidate"
      WHERE "candidate"."run_group_id" IS NOT NULL
        AND "candidate"."goal_id" IS NULL
        AND EXISTS (
          SELECT 1
          FROM "thread_goals" AS "goal"
          WHERE "goal"."id" = "candidate"."run_group_id"
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

CALL "backfill_zero_run_goal_ids_0885"();--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_zero_run_goal_ids_0885"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Full consistency check over the finished backfill. Any residue — a payload
-- that disagrees with its legacy leaves, an interrupt or goal pointer that
-- was not canonicalized, a duplicated interrupt target, or a zero_run whose
-- surviving goal was not adopted — fails the migration.
DO $$
DECLARE
  residual_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO residual_count
  FROM "chat_events"
  WHERE "payload" IS DISTINCT FROM "canonical_chat_event_payload_0885"("chat_events");
  IF residual_count > 0 THEN
    RAISE EXCEPTION
      'chat_events has % rows whose payload disagrees with the legacy leaves',
      residual_count;
  END IF;

  SELECT COUNT(*)
  INTO residual_count
  FROM "chat_events"
  WHERE "event_type" = 'control.interrupt'
    AND "interrupts_run_id" IS NOT NULL
    AND "run_id" IS DISTINCT FROM "interrupts_run_id";
  IF residual_count > 0 THEN
    RAISE EXCEPTION
      'chat_events has % control.interrupt rows without a canonical run_id',
      residual_count;
  END IF;

  SELECT COUNT(*)
  INTO residual_count
  FROM "chat_events"
  WHERE "run_group_id" IS NOT NULL
    AND ("context_type" IS DISTINCT FROM 'goal'
      OR "context_id" IS DISTINCT FROM "run_group_id");
  IF residual_count > 0 THEN
    RAISE EXCEPTION
      'chat_events has % goal-grouped rows without canonical context pointers',
      residual_count;
  END IF;

  SELECT COUNT(*)
  INTO residual_count
  FROM (
    SELECT "run_id"
    FROM "chat_events"
    WHERE "event_type" = 'control.interrupt'
      AND "run_id" IS NOT NULL
    GROUP BY "run_id"
    HAVING COUNT(*) > 1
  ) AS "duplicated";
  IF residual_count > 0 THEN
    RAISE EXCEPTION
      'chat_events has % run_ids with more than one control.interrupt row',
      residual_count;
  END IF;

  SELECT COUNT(*)
  INTO residual_count
  FROM "zero_runs"
  WHERE "run_group_id" IS NOT NULL
    AND "goal_id" IS DISTINCT FROM "run_group_id"
    AND EXISTS (
      SELECT 1
      FROM "thread_goals"
      WHERE "thread_goals"."id" = "zero_runs"."run_group_id"
    );
  IF residual_count > 0 THEN
    RAISE EXCEPTION
      'zero_runs has % rows without a canonical goal_id',
      residual_count;
  END IF;
END;
$$;--> statement-breakpoint

DROP FUNCTION IF EXISTS "canonical_chat_event_payload_0885"("chat_events");--> statement-breakpoint

-- With run_id now the canonical interrupt pointer, enforce one
-- control.interrupt per target run on the canonical column, mirroring
-- chat_events_interrupts_run_id_not_null_unique. Concurrent index builds can
-- leave an invalid index behind when interrupted; drop the new index name
-- first so the full migration is safe to retry.
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_control_interrupt_run_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "chat_events_control_interrupt_run_id_unique" ON "chat_events" USING btree ("run_id") WHERE "chat_events"."event_type" = 'control.interrupt' AND "chat_events"."run_id" IS NOT NULL;
