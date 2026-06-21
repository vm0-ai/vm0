-- Agent-scoped workflow ownership (1:N redesign). See vm0-ai/vm0#18434.
--
-- Moves the workflow->agent link from the `zero_workflow_agents` junction (and
-- from `zero_workflow_triggers.agent_id`) onto `zero_workflows.agent_id`, makes
-- it a hard NOT NULL 1:N ownership with ON DELETE CASCADE, and drops the
-- junction table + trigger agent column.
--
-- Production data is small (~174 rows); the agent_id backfill, multi-bind
-- duplication, and orphan deletion run inline here. The R2 volume re-key and
-- the SKILL.md -> instruction backfill require object-storage I/O and live in
-- packages/db/scripts/migrations/ instead.

-- 1. New columns (nullable agent_id during backfill).
ALTER TABLE "zero_workflows" ADD COLUMN "agent_id" uuid;
ALTER TABLE "zero_workflows" ADD COLUMN "request_to_publish" boolean DEFAULT false NOT NULL;
ALTER TABLE "zero_workflows" ADD COLUMN "instruction" text;

-- 2. Backfill agent_id from the junction. The original row keeps the earliest
--    bound agent; additional agents become independent copies in step 3.
UPDATE "zero_workflows" w
SET "agent_id" = sub."agent_id"
FROM (
  SELECT DISTINCT ON ("workflow_id") "workflow_id", "agent_id"
  FROM "zero_workflow_agents"
  ORDER BY "workflow_id", "created_at" ASC, "id" ASC
) sub
WHERE w."id" = sub."workflow_id" AND w."agent_id" IS NULL;

-- 3. Duplicate multi-bound workflows: one independent row per *additional*
--    agent (new uuid, same slug, copied metadata). The copies carry no triggers
--    and no junction rows; their R2 volumes are cloned by the data script.
INSERT INTO "zero_workflows" (
  "org_id", "agent_id", "name", "visibility", "request_to_publish", "type",
  "active", "preference", "instruction", "owner_user_id", "display_name",
  "description", "created_by", "created_at", "updated_at"
)
SELECT
  w."org_id", wa."agent_id", w."name", w."visibility", w."request_to_publish",
  w."type", w."active", w."preference", w."instruction", w."owner_user_id",
  w."display_name", w."description", w."created_by", w."created_at", now()
FROM "zero_workflow_agents" wa
JOIN "zero_workflows" w ON w."id" = wa."workflow_id"
WHERE wa."agent_id" <> w."agent_id";

-- 4. Backfill agent_id from triggers for rows with no junction (covers goals,
--    whose only agent link is their thread-idle trigger, and any workflow whose
--    junction row was lost but whose trigger still points at an agent).
UPDATE "zero_workflows" w
SET "agent_id" = sub."agent_id"
FROM (
  SELECT DISTINCT ON ("workflow_id") "workflow_id", "agent_id"
  FROM "zero_workflow_triggers"
  WHERE "agent_id" IS NOT NULL
  ORDER BY "workflow_id", "created_at" ASC, "id" ASC
) sub
WHERE w."id" = sub."workflow_id" AND w."agent_id" IS NULL;

-- 5. Delete true-orphan workflows (no junction, no trigger agent). Goals are
--    never deleted here; a goal without an agent is a separate bug to fix.
DELETE FROM "zero_workflows" WHERE "type" = 'workflow' AND "agent_id" IS NULL;

-- 6. Enforce hard 1:N ownership.
ALTER TABLE "zero_workflows" ALTER COLUMN "agent_id" SET NOT NULL;
ALTER TABLE "zero_workflows"
  ADD CONSTRAINT "zero_workflows_agent_id_zero_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id")
  ON DELETE cascade ON UPDATE no action;
CREATE INDEX "idx_zero_workflows_agent" ON "zero_workflows" ("agent_id", "name");

-- 7. slug (name) is no longer unique per org.
DROP INDEX IF EXISTS "idx_zero_workflows_org_name";

-- 8. The agent link now lives only on the workflow row.
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT IF EXISTS "zero_workflow_triggers_agent_id_zero_agents_id_fk";
ALTER TABLE "zero_workflow_triggers" DROP COLUMN "agent_id";

-- 9. Drop the junction table.
DROP TABLE "zero_workflow_agents";
