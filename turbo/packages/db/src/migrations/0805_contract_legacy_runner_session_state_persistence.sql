-- This migration performs a bounded invariant read and catalog-only DDL
-- on a continuously updated table.
-- Fail instead of queueing behind heartbeat traffic.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Freeze the bridge invariant before checking it and removing either side.
LOCK TABLE "runner_state" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "runner_state"
    WHERE "held_sandbox_states" IS DISTINCT FROM "held_session_states"
  ) THEN
    RAISE EXCEPTION
      'Cannot contract runner sandbox state persistence: bridge values diverge';
  END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "runner_state"
DROP CONSTRAINT "chk_runner_state_held_sandbox_states_match";--> statement-breakpoint

DROP TRIGGER "bridge_runner_state_sandbox_states_0800"
ON "runner_state";--> statement-breakpoint

DROP FUNCTION "bridge_runner_state_sandbox_states_0800"();--> statement-breakpoint

ALTER TABLE "runner_state" DROP COLUMN "held_session_states";
