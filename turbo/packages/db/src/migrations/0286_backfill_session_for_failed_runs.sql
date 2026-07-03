-- Backfill agent_sessions for legacy failed runs whose session_id is NULL.
-- Since #10290, every agent_runs row gets a session eagerly at INSERT time, so
-- the current invariant is that failed runs still have a session (with
-- conversation_id=NULL). Pre-deploy rows predate that behaviour.

-- Step 1: Delete runs whose agent compose is gone — we can't synthesize a
-- session without a valid agent_compose_id.
DELETE FROM "agent_runs"
WHERE "session_id" IS NULL
  AND "agent_compose_version_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "conversations" c WHERE c."run_id" = "agent_runs"."id"
  );
--> statement-breakpoint

-- Step 2: Assign a fresh session_id to remaining NULL-session runs that have
-- no conversation (i.e. failed before the checkpoint webhook fired).
UPDATE "agent_runs"
SET "session_id" = gen_random_uuid()
WHERE "session_id" IS NULL
  AND "agent_compose_version_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "conversations" c WHERE c."run_id" = "agent_runs"."id"
  );
--> statement-breakpoint

-- Step 3: Create the matching agent_sessions rows (conversation_id=NULL), the
-- same state eager session creation produces for runs that never reach the
-- checkpoint webhook.
INSERT INTO "agent_sessions" ("id", "user_id", "agent_compose_id", "org_id", "created_at", "updated_at")
SELECT r."session_id", r."user_id", v."compose_id", r."org_id", r."created_at", r."created_at"
FROM "agent_runs" r
JOIN "agent_compose_versions" v ON v."id" = r."agent_compose_version_id"
WHERE r."session_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "agent_sessions" s WHERE s."id" = r."session_id");
