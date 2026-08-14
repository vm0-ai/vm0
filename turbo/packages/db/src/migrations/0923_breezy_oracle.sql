-- vm0:non-transactional
-- DB/API expand phase: install the nullable cursor and compatibility writer in
-- one short transaction before backfilling existing rows. The previous API
-- does not know last_event_id, so the trigger keeps concurrent writes valid
-- throughout the observed 102-minute rollout/rollback window.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "chat_event_snapshots"
ADD COLUMN IF NOT EXISTS "last_event_id" uuid;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "set_chat_event_snapshot_last_event_id"() RETURNS trigger AS $$
BEGIN
  IF NEW."last_event_id" IS NULL THEN
    SELECT "chat_events"."id"
    INTO NEW."last_event_id"
    FROM "chat_events"
    WHERE "chat_events"."chat_thread_id" = NEW."chat_thread_id"
      AND "chat_events"."seq_id" <= NEW."last_seq_id"
    ORDER BY "chat_events"."seq_id" DESC
    LIMIT 1;
  END IF;

  IF NEW."last_event_id" IS NULL THEN
    RAISE EXCEPTION 'A Chat Event Snapshot has no physical event at or before its cursor';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "chat_event_snapshots_fill_last_event_id"
ON "chat_event_snapshots";
--> statement-breakpoint
CREATE TRIGGER "chat_event_snapshots_fill_last_event_id"
BEFORE INSERT OR UPDATE OF "last_seq_id" ON "chat_event_snapshots"
FOR EACH ROW EXECUTE FUNCTION "set_chat_event_snapshot_last_event_id"();
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Keep index construction outside a transaction so normal reads and writes
-- can continue. Dropping first also recovers a partial concurrent-index build
-- when this non-transactional migration is retried.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5min';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "chat_event_snapshots_thread_version_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_event_snapshots_thread_version_idx"
ON "chat_event_snapshots" USING btree (
  "chat_thread_id",
  "archive_schema_version"
);
--> statement-breakpoint

-- Backfill existing rows in small transactions. A UUID scan cursor avoids
-- repeatedly scanning completed rows, while SKIP LOCKED keeps the migration
-- from waiting behind concurrent Snapshot refreshes. Rows skipped below the
-- cursor are revisited after each complete pass.
CREATE OR REPLACE PROCEDURE "backfill_chat_event_snapshot_last_event_ids_0923"(
  p_no_progress_timeout interval
)
LANGUAGE plpgsql AS $$
DECLARE
  v_scan_after uuid := NULL;
  v_batch_ids uuid[];
  v_updated_ids uuid[];
  v_batch_count integer;
  v_updated_count integer;
  v_remaining boolean;
  v_no_progress_started_at timestamp with time zone := clock_timestamp();
BEGIN
  IF
    p_no_progress_timeout IS NULL
    OR p_no_progress_timeout <= interval '0 seconds'
    OR p_no_progress_timeout > interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Chat Event Snapshot backfill no-progress timeout must be between 0 and 30 seconds';
  END IF;

  -- statement_timeout is armed before CALL arrives, so PostgreSQL 17
  -- transaction_timeout is the effective bound for each internal segment.
  SET LOCAL lock_timeout = '1s';
  SET LOCAL transaction_timeout = '5min';

  LOOP
    WITH "batch" AS MATERIALIZED (
      SELECT
        "snapshot"."id",
        "last_event"."id" AS "last_event_id"
      FROM "chat_event_snapshots" AS "snapshot"
      LEFT JOIN LATERAL (
        SELECT "chat_events"."id"
        FROM "chat_events"
        WHERE "chat_events"."chat_thread_id" = "snapshot"."chat_thread_id"
          AND "chat_events"."seq_id" <= "snapshot"."last_seq_id"
        ORDER BY "chat_events"."seq_id" DESC
        LIMIT 1
      ) AS "last_event" ON TRUE
      WHERE (v_scan_after IS NULL OR "snapshot"."id" > v_scan_after)
        AND "snapshot"."last_event_id" IS NULL
      ORDER BY "snapshot"."id"
      LIMIT 500
      FOR UPDATE OF "snapshot" SKIP LOCKED
    ),
    "updated" AS (
      UPDATE "chat_event_snapshots" AS "snapshot"
      SET "last_event_id" = "batch"."last_event_id"
      FROM "batch"
      WHERE "snapshot"."id" = "batch"."id"
        AND "snapshot"."last_event_id" IS NULL
        AND "batch"."last_event_id" IS NOT NULL
      RETURNING "snapshot"."id"
    )
    SELECT
      coalesce(
        (SELECT array_agg("id" ORDER BY "id") FROM "batch"),
        ARRAY[]::uuid[]
      ),
      coalesce(
        (SELECT array_agg("id" ORDER BY "id") FROM "updated"),
        ARRAY[]::uuid[]
      )
    INTO v_batch_ids, v_updated_ids;

    v_batch_count := cardinality(v_batch_ids);
    v_updated_count := cardinality(v_updated_ids);

    IF v_updated_count <> v_batch_count THEN
      RAISE EXCEPTION 'A Chat Event Snapshot has no physical event at or before its cursor';
    END IF;

    IF v_batch_count > 0 THEN
      v_scan_after := v_batch_ids[v_batch_count];
      v_no_progress_started_at := clock_timestamp();
    END IF;

    COMMIT;
    SET LOCAL lock_timeout = '1s';
    SET LOCAL transaction_timeout = '5min';

    IF v_batch_count > 0 THEN
      PERFORM pg_sleep(0.05);
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM "chat_event_snapshots"
      WHERE "last_event_id" IS NULL
    )
    INTO v_remaining;

    IF NOT v_remaining THEN
      EXIT;
    END IF;

    IF clock_timestamp() - v_no_progress_started_at >= p_no_progress_timeout THEN
      RAISE EXCEPTION 'Chat Event Snapshot backfill made no progress for % while eligible rows remained',
        p_no_progress_timeout;
    END IF;

    v_scan_after := NULL;
    PERFORM pg_sleep(0.05);
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "backfill_chat_event_snapshot_last_event_ids_0923"(interval '30 seconds');
--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_chat_event_snapshot_last_event_ids_0923"(interval);
--> statement-breakpoint

BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_event_snapshots"
    WHERE "last_event_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'A Chat Event Snapshot has no physical event at or before its cursor';
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
