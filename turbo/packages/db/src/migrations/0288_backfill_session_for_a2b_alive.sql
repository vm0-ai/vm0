-- Backfill agent_runs.session_id for the A2b "compose-alive" bucket: legacy
-- runs that have a live agent_compose_version and a conversations row, but
-- session_id IS NULL. These rows predate the agent_runs.session_id column
-- being added; after this migration, agent_runs.session_id IS NULL should be
-- empty, unblocking the upcoming NOT NULL + FK constraint.

-- Step 1: Recover sibling session_id. If another run for the same user,
-- compose and cli_agent_session_id already has a session, reuse it. This
-- matches the runtime continuation semantic: runs sharing a cli_agent_session_id
-- should share a vm0 session_id.
UPDATE "agent_runs" r
SET "session_id" = sibling."session_id"
FROM (
  SELECT DISTINCT ON (t.id)
    t.id AS run_id,
    o."session_id"
  FROM "agent_runs" t
  JOIN "conversations" tc ON tc."run_id" = t.id
  JOIN "agent_compose_versions" tv ON tv."id" = t."agent_compose_version_id"
  JOIN "agent_runs" o
    ON o."user_id" = t."user_id"
    AND o."session_id" IS NOT NULL
  JOIN "conversations" oc
    ON oc."run_id" = o."id"
    AND oc."cli_agent_session_id" = tc."cli_agent_session_id"
  JOIN "agent_compose_versions" ov
    ON ov."id" = o."agent_compose_version_id"
    AND ov."compose_id" = tv."compose_id"
  WHERE t."session_id" IS NULL
  ORDER BY t.id, o."created_at" ASC
) sibling
WHERE r."id" = sibling.run_id;
--> statement-breakpoint

-- Step 2: Mint a new session_id per (user, compose, cli_agent_session_id)
-- triple for the remaining orphans. WITH ... AS MATERIALIZED forces
-- gen_random_uuid() to evaluate once per group, so all rows in the group
-- share the same new session.
WITH orphan_groups AS MATERIALIZED (
  SELECT
    r."user_id",
    v."compose_id",
    c."cli_agent_session_id",
    gen_random_uuid() AS new_session_id
  FROM "agent_runs" r
  JOIN "conversations" c ON c."run_id" = r."id"
  JOIN "agent_compose_versions" v ON v."id" = r."agent_compose_version_id"
  WHERE r."session_id" IS NULL
  GROUP BY r."user_id", v."compose_id", c."cli_agent_session_id"
)
UPDATE "agent_runs" r
SET "session_id" = g.new_session_id
FROM orphan_groups g, "conversations" c, "agent_compose_versions" v
WHERE c."run_id" = r."id"
  AND v."id" = r."agent_compose_version_id"
  AND r."session_id" IS NULL
  AND r."user_id" = g."user_id"
  AND v."compose_id" = g."compose_id"
  AND c."cli_agent_session_id" = g."cli_agent_session_id";
--> statement-breakpoint

-- Step 3: Create agent_sessions rows for every session_id now referenced by a
-- run but missing from agent_sessions. Sibling-inherited sessions (Step 1)
-- already exist in agent_sessions, so NOT EXISTS filters them out — only the
-- Step-2-minted sessions get inserted.
INSERT INTO "agent_sessions" ("id", "user_id", "agent_compose_id", "org_id", "created_at", "updated_at")
SELECT DISTINCT ON (r."session_id")
  r."session_id",
  r."user_id",
  v."compose_id",
  r."org_id",
  r."created_at",
  r."created_at"
FROM "agent_runs" r
JOIN "agent_compose_versions" v ON v."id" = r."agent_compose_version_id"
WHERE r."session_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "agent_sessions" s WHERE s."id" = r."session_id"
  )
ORDER BY r."session_id", r."created_at" ASC;
