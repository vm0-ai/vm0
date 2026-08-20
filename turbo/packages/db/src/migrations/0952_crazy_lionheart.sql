-- vm0:non-transactional

-- Install the nullable compatibility state and write guard under short locks.
-- Conditional DDL keeps this non-transactional migration safe to retry after
-- an interrupted concurrent index build.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "usage_finalization_state" varchar(32);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_runs_usage_finalization_state_check'
      AND conrelid = 'agent_runs'::regclass
  ) THEN
    ALTER TABLE "agent_runs"
      ADD CONSTRAINT "agent_runs_usage_finalization_state_check"
      CHECK ("usage_finalization_state" IN ('pending', 'deliveryFinalized', 'finalized'))
      NOT VALID;
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_agent_run_usage_seal"() RETURNS trigger AS $$
DECLARE
  run_usage_finalization_state varchar(32);
BEGIN
  IF NEW.run_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT usage_finalization_state
    INTO run_usage_finalization_state
    FROM agent_runs
    WHERE id = NEW.run_id
    FOR UPDATE;

  IF run_usage_finalization_state = 'finalized'
    AND NOT EXISTS (
      SELECT 1
      FROM usage_event
      WHERE idempotency_key = NEW.idempotency_key
        AND run_id IS NOT DISTINCT FROM NEW.run_id
        AND org_id = NEW.org_id
        AND user_id = NEW.user_id
        AND kind = NEW.kind
        AND provider = NEW.provider
        AND category = NEW.category
        AND quantity = NEW.quantity
    )
  THEN
    RAISE EXCEPTION 'agent run usage is sealed'
      USING ERRCODE = '23514',
            CONSTRAINT = 'usage_event_agent_run_usage_seal';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "usage_event_enforce_agent_run_usage_seal" ON "usage_event";
--> statement-breakpoint
CREATE TRIGGER "usage_event_enforce_agent_run_usage_seal"
BEFORE INSERT ON "usage_event"
FOR EACH ROW
EXECUTE FUNCTION "enforce_agent_run_usage_seal"();
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- Concurrent index builds can leave an invalid index behind when interrupted.
-- Drop first so replay always rebuilds a usable index.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5min';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_usage_delivery_finalized";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_agent_runs_usage_delivery_finalized"
ON "agent_runs" USING btree ("id")
WHERE "usage_finalization_state" = 'deliveryFinalized';
--> statement-breakpoint

ALTER TABLE "agent_runs"
VALIDATE CONSTRAINT "agent_runs_usage_finalization_state_check";
