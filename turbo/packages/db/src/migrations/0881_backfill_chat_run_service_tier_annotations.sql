-- vm0:non-transactional
-- Backfill immutable run-tier provenance without a table-wide update. Each
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

-- Keep the JSON transformation shared by the trigger guard and the batched
-- update so the temporary append-only exception cannot accept a broader
-- transition than the migration performs.
CREATE OR REPLACE FUNCTION "annotate_chat_event_priority_0881"(
  "source_user_message" jsonb
) RETURNS jsonb AS $$
  SELECT jsonb_set(
    "source_user_message",
    '{parts}',
    (
      SELECT jsonb_agg(
        CASE
          WHEN "part"."value" ->> 'type' = 'model'
          THEN jsonb_set(
            "part"."value",
            '{serviceTier}',
            to_jsonb('priority'::text),
            true
          )
          ELSE "part"."value"
        END
        ORDER BY "part"."ordinality"
      )
      FROM jsonb_array_elements("source_user_message" -> 'parts')
        WITH ORDINALITY AS "part"("value", "ordinality")
    ),
    false
  );
$$ LANGUAGE sql IMMUTABLE STRICT;--> statement-breakpoint

-- Keep append-only protection installed while narrowly permitting the exact
-- model-tier annotation derived from zero_runs.codex_service_tier. Every other
-- column and every other user_message transition remain immutable.
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
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(OLD."user_message" -> 'parts') AS "part"
      WHERE "part" ->> 'type' = 'model'
        AND "part" ->> 'serviceTier' IS DISTINCT FROM 'priority'
    )
  THEN
    SELECT "annotate_chat_event_priority_0881"(OLD."user_message")
    INTO expected_user_message
    FROM "zero_runs" AS "run"
    WHERE "run"."id" = OLD."run_id"
      AND "run"."codex_service_tier" = 'fast';

    IF expected_user_message IS NOT NULL
      AND NEW."user_message" = expected_user_message
    THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE PROCEDURE "backfill_chat_run_service_tier_annotations_0881"()
LANGUAGE plpgsql AS $$
DECLARE
  batch_last_id uuid;
  last_id uuid;
  demoted_head_count bigint;
  updated_thread_ids uuid[];
  updated_seq_ids bigint[];
BEGIN
  LOOP
    batch_last_id := NULL;
    demoted_head_count := NULL;
    updated_thread_ids := NULL;
    updated_seq_ids := NULL;

    WITH batch AS (
      SELECT "candidate"."id"
      FROM "chat_events" AS "candidate"
      INNER JOIN "zero_runs" AS "run"
        ON "run"."id" = "candidate"."run_id"
      WHERE (last_id IS NULL OR "candidate"."id" > last_id)
        AND "candidate"."user_message" IS NOT NULL
        AND jsonb_typeof("candidate"."user_message" -> 'parts') = 'array'
        AND "run"."codex_service_tier" = 'fast'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            "candidate"."user_message" -> 'parts'
          ) AS "part"
          WHERE "part" ->> 'type' = 'model'
            AND "part" ->> 'serviceTier' IS DISTINCT FROM 'priority'
        )
      ORDER BY "candidate"."id"
      LIMIT 500
      FOR UPDATE OF "candidate" SKIP LOCKED
    ), updated AS (
      UPDATE "chat_events" AS "target"
      SET "user_message" = "annotate_chat_event_priority_0881"(
        "target"."user_message"
      )
      FROM batch
      WHERE "target"."id" = batch."id"
      RETURNING
        "target"."id",
        "target"."chat_thread_id",
        "target"."seq_id"
    )
    SELECT
      (array_agg("updated"."id" ORDER BY "updated"."id" DESC))[1],
      array_agg(
        "updated"."chat_thread_id"
        ORDER BY "updated"."id"
      ),
      array_agg("updated"."seq_id" ORDER BY "updated"."id")
    INTO batch_last_id, updated_thread_ids, updated_seq_ids
    FROM updated;

    IF batch_last_id IS NOT NULL THEN
      -- Snapshot publication reads event bytes before its short head-swap
      -- transaction. If that transaction wins the old-head row lock, the
      -- first UPDATE below can recheck and skip the old row while its new head
      -- remains invisible to that statement snapshot. Keep the updated rows
      -- in arrays and retry with fresh statement snapshots until no covering
      -- head remains. Once a visible head is demoted, any publisher built from
      -- that expected parent loses its guarded swap after this batch commits.
      LOOP
        UPDATE "chat_event_snapshots" AS "snapshot"
        SET "is_head" = false
        WHERE "snapshot"."is_head"
          AND EXISTS (
            SELECT 1
            FROM unnest(updated_thread_ids, updated_seq_ids)
              AS "updated"("chat_thread_id", "seq_id")
            WHERE "updated"."chat_thread_id" = "snapshot"."chat_thread_id"
              AND "updated"."seq_id" <= "snapshot"."last_seq_id"
          );
        GET DIAGNOSTICS demoted_head_count = ROW_COUNT;

        IF demoted_head_count > 0 THEN
          CONTINUE;
        END IF;

        -- This separate statement sees a replacement head committed while
        -- the UPDATE above was waiting on its expected parent.
        PERFORM 1
        FROM "chat_event_snapshots" AS "snapshot"
        WHERE "snapshot"."is_head"
          AND EXISTS (
            SELECT 1
            FROM unnest(updated_thread_ids, updated_seq_ids)
              AS "updated"("chat_thread_id", "seq_id")
            WHERE "updated"."chat_thread_id" = "snapshot"."chat_thread_id"
              AND "updated"."seq_id" <= "snapshot"."last_seq_id"
          )
        LIMIT 1;

        IF NOT FOUND THEN
          EXIT;
        END IF;
      END LOOP;
    END IF;

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
        AND "run"."codex_service_tier" = 'fast'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            "candidate"."user_message" -> 'parts'
          ) AS "part"
          WHERE "part" ->> 'type' = 'model'
            AND "part" ->> 'serviceTier' IS DISTINCT FROM 'priority'
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

CALL "backfill_chat_run_service_tier_annotations_0881"();--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_chat_run_service_tier_annotations_0881"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP FUNCTION IF EXISTS "annotate_chat_event_priority_0881"(jsonb);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events" AS "candidate"
    INNER JOIN "zero_runs" AS "run"
      ON "run"."id" = "candidate"."run_id"
    WHERE "candidate"."user_message" IS NOT NULL
      AND jsonb_typeof("candidate"."user_message" -> 'parts') = 'array'
      AND "run"."codex_service_tier" = 'fast'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          "candidate"."user_message" -> 'parts'
        ) AS "part"
        WHERE "part" ->> 'type' = 'model'
          AND "part" ->> 'serviceTier' IS DISTINCT FROM 'priority'
      )
  ) THEN
    RAISE EXCEPTION 'Eligible chat_events still lack a priority model annotation';
  END IF;
END;
$$;
