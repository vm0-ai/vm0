-- Migration: Replace zero_agents PK with agent_composes.id (composeId)
-- This eliminates the dual-ID architecture where zero_agents.id and agent_composes.id
-- were different UUIDs for the same logical agent.

-- Step 1: Add temporary compose_id column
ALTER TABLE "zero_agents" ADD COLUMN "compose_id" uuid;

-- Step 2: Populate compose_id from agent_composes via (org_id, name) join
UPDATE "zero_agents" za
SET "compose_id" = ac."id"
FROM "agent_composes" ac
WHERE ac."org_id" = za."org_id" AND ac."name" = za."name";

-- Step 3: Update downstream FK columns to use compose_id values (before dropping FKs)
-- 3a: zero_agent_schedules
UPDATE "zero_agent_schedules" zas
SET "agent_id" = za."compose_id"
FROM "zero_agents" za
WHERE zas."agent_id" = za."id" AND za."compose_id" IS NOT NULL;

DELETE FROM "zero_agent_schedules"
WHERE "agent_id" IN (SELECT "id" FROM "zero_agents" WHERE "compose_id" IS NULL);

-- 3b: email_thread_sessions
UPDATE "email_thread_sessions" ets
SET "agent_id" = za."compose_id"
FROM "zero_agents" za
WHERE ets."agent_id" = za."id" AND za."compose_id" IS NOT NULL;

DELETE FROM "email_thread_sessions"
WHERE "agent_id" IN (SELECT "id" FROM "zero_agents" WHERE "compose_id" IS NULL);

-- 3c: org_metadata
UPDATE "org_metadata" om
SET "default_agent_id" = za."compose_id"
FROM "zero_agents" za
WHERE om."default_agent_id" = za."id" AND za."compose_id" IS NOT NULL;

UPDATE "org_metadata"
SET "default_agent_id" = NULL
WHERE "default_agent_id" IN (SELECT "id" FROM "zero_agents" WHERE "compose_id" IS NULL);

-- 3d: org_members_metadata pinned_agent_ids (JSONB array)
UPDATE "org_members_metadata" omm
SET "pinned_agent_ids" = (
  SELECT COALESCE(jsonb_agg(COALESCE(za."compose_id"::text, elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text(omm."pinned_agent_ids") AS elem
  LEFT JOIN "zero_agents" za ON za."id"::text = elem
)
WHERE "pinned_agent_ids" IS NOT NULL
  AND "pinned_agent_ids" != '[]'::jsonb;

-- Step 4: Drop FK constraints referencing zero_agents.id
ALTER TABLE "zero_agent_schedules" DROP CONSTRAINT IF EXISTS "zero_agent_schedules_agent_id_zero_agents_id_fk";
ALTER TABLE "email_thread_sessions" DROP CONSTRAINT IF EXISTS "email_thread_sessions_agent_id_zero_agents_id_fk";
ALTER TABLE "org_metadata" DROP CONSTRAINT IF EXISTS "org_metadata_default_agent_id_zero_agents_id_fk";

-- Step 5: Drop PK and indexes on zero_agents
ALTER TABLE "zero_agents" DROP CONSTRAINT "zero_agents_pkey";
DROP INDEX IF EXISTS "idx_zero_agents_org_name";
DROP INDEX IF EXISTS "idx_zero_agents_org";

-- Step 6: Delete orphaned zero_agents rows (no matching compose)
DELETE FROM "zero_agents" WHERE "compose_id" IS NULL;

-- Step 7: Swap id column with compose_id
ALTER TABLE "zero_agents" DROP COLUMN "id";
ALTER TABLE "zero_agents" RENAME COLUMN "compose_id" TO "id";
ALTER TABLE "zero_agents" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "zero_agents" ADD PRIMARY KEY ("id");

-- Step 8: Add FK from zero_agents.id → agent_composes.id
ALTER TABLE "zero_agents"
  ADD CONSTRAINT "zero_agents_id_agent_composes_id_fk"
  FOREIGN KEY ("id") REFERENCES "agent_composes"("id") ON DELETE CASCADE;

-- Step 9: Re-create indexes on zero_agents
CREATE UNIQUE INDEX "idx_zero_agents_org_name" ON "zero_agents" ("org_id", "name");
CREATE INDEX "idx_zero_agents_org" ON "zero_agents" ("org_id");

-- Step 10: Re-create FK constraints on downstream tables
ALTER TABLE "zero_agent_schedules"
  ADD CONSTRAINT "zero_agent_schedules_agent_id_zero_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "zero_agents"("id") ON DELETE CASCADE;

ALTER TABLE "email_thread_sessions"
  ADD CONSTRAINT "email_thread_sessions_agent_id_zero_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "zero_agents"("id") ON DELETE CASCADE;

ALTER TABLE "org_metadata"
  ADD CONSTRAINT "org_metadata_default_agent_id_zero_agents_id_fk"
  FOREIGN KEY ("default_agent_id") REFERENCES "zero_agents"("id") ON DELETE SET NULL;
