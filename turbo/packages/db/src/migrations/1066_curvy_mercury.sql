-- vm0:non-transactional
-- Install the nullable storage and its unvalidated check under a short catalog
-- lock, then release that lock before scanning historical Chat Events.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "chat_events"
ADD COLUMN IF NOT EXISTS "failure_reason" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" = 'chat_events_failure_reason_event_type_check'
      AND "conrelid" = 'public.chat_events'::regclass
  ) THEN
    ALTER TABLE "chat_events"
    ADD CONSTRAINT "chat_events_failure_reason_event_type_check"
    CHECK (
      "failure_reason" IS NULL
      OR "event_type" = 'run.failed'
    ) NOT VALID;
  END IF;
END;
$$;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- VALIDATE takes a ShareUpdateExclusiveLock, which remains compatible with
-- ordinary INSERT, UPDATE, and DELETE traffic while PostgreSQL scans old rows.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
ALTER TABLE "chat_events"
VALIDATE CONSTRAINT "chat_events_failure_reason_event_type_check";
--> statement-breakpoint
COMMIT;
