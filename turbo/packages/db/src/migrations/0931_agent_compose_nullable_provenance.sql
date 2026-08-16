-- vm0:non-transactional
-- Stage 0 expand phase for bounded, de-identified Agent Compose version
-- retention. Keep every catalog change in one short transaction; validation
-- runs only after its catalog locks have committed.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_agent_compose_version_write_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT'
    AND (NEW."compose_id" IS NULL OR NEW."created_by" IS NULL)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'agent_compose_versions INSERT requires compose_id and created_by';
  END IF;

  IF NEW."created_by" IS NOT NULL
    AND NOT pg_try_advisory_xact_lock(
      hashtextextended(NEW."created_by", 27604)
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'agent_compose_versions provenance write conflicts with user cleanup';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "veto_agent_compose_version_delete_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'agent_compose_versions DELETE is disabled during bounded retention';
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "guard_clerk_user_cleanup_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cleanup_revision text := current_setting(
    'vm0.clerk_user_cleanup_revision',
    true
  );
  deleted_user_id text := current_setting(
    'vm0.clerk_deleted_user_id',
    true
  );
BEGIN
  IF cleanup_revision IS DISTINCT FROM 'stage0_nullable_provenance'
    OR deleted_user_id IS NULL
    OR deleted_user_id = ''
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'legacy Clerk user cleanup is disabled during bounded retention';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended(deleted_user_id, 27604)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'Clerk user cleanup conflicts with a provenance writer';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_compose_versions"
    WHERE "created_by" = deleted_user_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Clerk user cleanup requires complete version de-identification';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "set_agent_compose_delete_lock_timeout_transition"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- This bounds FK row-lock waits for outgoing API revisions. The incoming
  -- revision sets the same timeout before issuing lifecycle DML, which also
  -- bounds acquisition of the DELETE statement's table lock.
  PERFORM set_config('lock_timeout', '100ms', true);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "agent_compose_versions_write_provenance"
ON "agent_compose_versions";
--> statement-breakpoint
CREATE TRIGGER "agent_compose_versions_write_provenance"
BEFORE INSERT OR UPDATE OF "created_by" ON "agent_compose_versions"
FOR EACH ROW
EXECUTE FUNCTION "enforce_agent_compose_version_write_transition"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "agent_compose_versions_delete_veto"
ON "agent_compose_versions";
--> statement-breakpoint
CREATE TRIGGER "agent_compose_versions_delete_veto"
BEFORE DELETE ON "agent_compose_versions"
FOR EACH STATEMENT
EXECUTE FUNCTION "veto_agent_compose_version_delete_transition"();
--> statement-breakpoint

-- The outgoing API reaches users last, so unrelated earlier deletions may
-- already be committed when this universal zero-row guard fails closed. Those
-- deletions are idempotent; the incoming revision repeats the exact creator
-- scrub and the users DELETE together so event replay converges.
DROP TRIGGER IF EXISTS "users_clerk_cleanup_transition_guard"
ON "users";
--> statement-breakpoint
CREATE TRIGGER "users_clerk_cleanup_transition_guard"
BEFORE DELETE ON "users"
FOR EACH STATEMENT
EXECUTE FUNCTION "guard_clerk_user_cleanup_transition"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "agent_composes_delete_lock_timeout_transition"
ON "agent_composes";
--> statement-breakpoint
CREATE TRIGGER "agent_composes_delete_lock_timeout_transition"
BEFORE DELETE ON "agent_composes"
FOR EACH STATEMENT
EXECUTE FUNCTION "set_agent_compose_delete_lock_timeout_transition"();
--> statement-breakpoint

COMMENT ON FUNCTION "enforce_agent_compose_version_write_transition"() IS
'Temporary Stage 0 INSERT invariant and creator-write serialization; remove with agent_compose_versions in Stage 8.';
--> statement-breakpoint
COMMENT ON FUNCTION "veto_agent_compose_version_delete_transition"() IS
'DB/API rollout fallback: retain through the observed ~102-minute mixed-revision window and rollback drain; remove in Stage 8 only after legacy revisions are drained and failed deletion events are replayed.';
--> statement-breakpoint
COMMENT ON FUNCTION "guard_clerk_user_cleanup_transition"() IS
'DB/API rollout fallback: fail old user cleanup closed even with zero matching identity or Agent rows; remove in Stage 8 after the observed ~102-minute window, rollback drain, and deletion-event replay are complete.';
--> statement-breakpoint
COMMENT ON FUNCTION "set_agent_compose_delete_lock_timeout_transition"() IS
'DB/API rollout fallback for old Agent DELETE FK waits; remove in Stage 8 after the observed ~102-minute window and rollback drain are closed.';
--> statement-breakpoint

ALTER TABLE "agent_compose_versions"
ALTER COLUMN "compose_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_compose_versions"
ALTER COLUMN "created_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_compose_versions"
DROP CONSTRAINT IF EXISTS "agent_compose_versions_compose_id_agent_composes_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_compose_versions"
ADD CONSTRAINT "agent_compose_versions_compose_id_agent_composes_id_fk"
FOREIGN KEY ("compose_id")
REFERENCES "agent_composes"("id")
ON DELETE SET NULL
NOT VALID;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint

-- PostgreSQL validates this FK without blocking ordinary SELECT, INSERT,
-- UPDATE, or DELETE traffic. Its scan is deliberately outside the DDL
-- transaction so the earlier catalog locks are no longer held.
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "agent_compose_versions"
VALIDATE CONSTRAINT "agent_compose_versions_compose_id_agent_composes_id_fk";
--> statement-breakpoint
COMMIT;
