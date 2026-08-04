-- Acquire the final ALTER TABLE lock mode up front so the migration either
-- starts promptly or retries instead of waiting behind heartbeat writers.
-- #24510 owns runtime cutover and #24512 owns bridge cleanup.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
LOCK TABLE "runner_state" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

ALTER TABLE "runner_state" ADD COLUMN "held_sandbox_states" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

UPDATE "runner_state"
SET "held_sandbox_states" = "held_session_states"
WHERE "held_sandbox_states" IS DISTINCT FROM "held_session_states";--> statement-breakpoint

CREATE FUNCTION "bridge_runner_state_sandbox_states_0800"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."held_sandbox_states"
      IS NOT DISTINCT FROM NEW."held_session_states"
    THEN
      RETURN NEW;
    ELSIF NEW."held_sandbox_states" = '[]'::jsonb THEN
      NEW."held_sandbox_states" := NEW."held_session_states";
    ELSIF NEW."held_session_states" = '[]'::jsonb THEN
      NEW."held_session_states" := NEW."held_sandbox_states";
    ELSE
      RAISE EXCEPTION 'runner sandbox state columns must match';
    END IF;
  ELSIF NEW."held_sandbox_states"
      IS DISTINCT FROM OLD."held_sandbox_states"
    AND NEW."held_session_states"
      IS DISTINCT FROM OLD."held_session_states"
  THEN
    IF NEW."held_sandbox_states"
      IS DISTINCT FROM NEW."held_session_states"
    THEN
      RAISE EXCEPTION 'runner sandbox state columns must match';
    END IF;
  ELSIF NEW."held_sandbox_states"
    IS DISTINCT FROM OLD."held_sandbox_states"
  THEN
    NEW."held_session_states" := NEW."held_sandbox_states";
  ELSIF NEW."held_session_states"
    IS DISTINCT FROM OLD."held_session_states"
  THEN
    NEW."held_sandbox_states" := NEW."held_session_states";
  ELSIF NEW."held_sandbox_states"
    IS DISTINCT FROM NEW."held_session_states"
  THEN
    RAISE EXCEPTION 'runner sandbox state columns must match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "bridge_runner_state_sandbox_states_0800"
BEFORE INSERT OR UPDATE OF "held_sandbox_states", "held_session_states"
ON "runner_state"
FOR EACH ROW
EXECUTE FUNCTION "bridge_runner_state_sandbox_states_0800"();--> statement-breakpoint

ALTER TABLE "runner_state" ADD CONSTRAINT "chk_runner_state_held_sandbox_states_match" CHECK ("runner_state"."held_sandbox_states" = "runner_state"."held_session_states");
