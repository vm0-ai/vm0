-- vm0:non-transactional
-- Adding the nullable column only needs a brief catalog lock. Fail promptly
-- instead of queueing behind long-lived writers; the backfill itself never
-- takes an explicit table lock.
SET lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "chat_events"
ADD COLUMN IF NOT EXISTS "run_event_sequence_number" integer;--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint

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

-- The draining release writes sequence_number while the next release writes
-- run_event_sequence_number. Mirror inserts in both directions without ever
-- updating an existing ChatEvent.
CREATE OR REPLACE FUNCTION "bridge_chat_event_run_event_sequence_number_0807"()
RETURNS trigger AS $$
BEGIN
  IF NEW."run_event_sequence_number" IS NULL THEN
    NEW."run_event_sequence_number" := NEW."sequence_number";
  ELSIF NEW."sequence_number" IS NULL THEN
    NEW."sequence_number" := NEW."run_event_sequence_number";
  ELSIF NEW."run_event_sequence_number"
    IS DISTINCT FROM NEW."sequence_number"
  THEN
    RAISE EXCEPTION 'chat event run event sequence columns must match';
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
      AND "tgname" = 'bridge_chat_event_run_event_sequence_number_0807'
      AND NOT "tgisinternal"
  ) THEN
    CREATE TRIGGER "bridge_chat_event_run_event_sequence_number_0807"
    BEFORE INSERT ON "chat_events"
    FOR EACH ROW
    EXECUTE FUNCTION "bridge_chat_event_run_event_sequence_number_0807"();
  END IF;
END;
$$;--> statement-breakpoint

-- Keep append-only protection installed while narrowly permitting only the
-- new twin column to be copied from sequence_number.
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_events'
    AND NEW."run_event_sequence_number"
      IS NOT DISTINCT FROM OLD."sequence_number"
    AND (to_jsonb(NEW) - 'run_event_sequence_number')
      = (to_jsonb(OLD) - 'run_event_sequence_number')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Backfill in 10,000-row transactions. The bridge above prevents concurrent
-- inserts from creating new gaps while each batch commits independently.
CREATE OR REPLACE PROCEDURE "backfill_chat_event_run_event_sequence_number_0807"()
LANGUAGE plpgsql AS $$
DECLARE
  updated_count integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT "ctid"
      FROM "chat_events"
      WHERE "run_event_sequence_number" IS DISTINCT FROM "sequence_number"
      ORDER BY "ctid"
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "chat_events" AS target
    SET "run_event_sequence_number" = target."sequence_number"
    FROM batch
    WHERE target."ctid" = batch."ctid";

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    COMMIT;
    EXIT WHEN updated_count = 0;
  END LOOP;
END;
$$;--> statement-breakpoint

CALL "backfill_chat_event_run_event_sequence_number_0807"();--> statement-breakpoint
DROP PROCEDURE IF EXISTS "backfill_chat_event_run_event_sequence_number_0807"();--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_events"
    WHERE "run_event_sequence_number" IS DISTINCT FROM "sequence_number"
  ) THEN
    RAISE EXCEPTION
      'Cannot establish canonical run_event_sequence_number storage';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Concurrent index builds can leave an invalid index behind when interrupted.
-- Drop only the new index name first so a full migration retry is idempotent;
-- the legacy unique index remains installed throughout.
DROP INDEX CONCURRENTLY IF EXISTS "chat_events_run_event_seq_unique";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "chat_events_run_event_seq_unique"
ON "chat_events" USING btree (
  "run_id",
  "run_event_sequence_number"
);
