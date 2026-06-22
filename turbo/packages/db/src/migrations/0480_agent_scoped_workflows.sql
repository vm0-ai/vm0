-- Agent-scoped workflow ownership (1:N redesign). See vm0-ai/vm0#18434.
--
-- Moves the workflow->agent link from the zero_workflow_agents junction (and
-- from zero_workflow_triggers.agent_id) onto zero_workflows.agent_id, makes it
-- a hard NOT NULL 1:N ownership with ON DELETE CASCADE, and drops the junction
-- table + trigger agent column. Production data (~174 rows) is transformed
-- inline. The R2 volume re-key and the SKILL.md -> instruction backfill require
-- object-storage I/O and live in packages/db/scripts/migrations/ instead.

-- 1. New columns (agent_id nullable during backfill).
ALTER TABLE "zero_workflows" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_workflows" ADD COLUMN "request_to_publish" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflows" ADD COLUMN "instruction" text;--> statement-breakpoint

-- 2. Backfill agent_id from the junction; the original row keeps the earliest
--    bound agent, additional agents become independent copies in step 3.
UPDATE "zero_workflows" w
SET "agent_id" = sub."agent_id"
FROM (
  SELECT DISTINCT ON ("workflow_id") "workflow_id", "agent_id"
  FROM "zero_workflow_agents"
  ORDER BY "workflow_id", "created_at" ASC, "id" ASC
) sub
WHERE w."id" = sub."workflow_id" AND w."agent_id" IS NULL;--> statement-breakpoint

-- 3. slug (name) is no longer unique per org. Drop this before duplicating
--    multi-bound workflows because those rows intentionally keep the same slug.
DROP INDEX IF EXISTS "idx_zero_workflows_org_name";--> statement-breakpoint

-- 4. Duplicate multi-bound workflows: one independent row per additional agent.
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
WHERE wa."agent_id" <> w."agent_id";--> statement-breakpoint

-- 5. Backfill agent_id from triggers for rows with no junction (goals, whose
--    only agent link is their thread-idle trigger, and any workflow whose
--    junction row was lost but whose trigger still points at an agent).
UPDATE "zero_workflows" w
SET "agent_id" = sub."agent_id"
FROM (
  SELECT DISTINCT ON ("workflow_id") "workflow_id", "agent_id"
  FROM "zero_workflow_triggers"
  WHERE "agent_id" IS NOT NULL
  ORDER BY "workflow_id", "created_at" ASC, "id" ASC
) sub
WHERE w."id" = sub."workflow_id" AND w."agent_id" IS NULL;--> statement-breakpoint

-- 6. Delete true-orphan workflows (no junction, no trigger agent). Goals are
--    never deleted here; a goal without an agent is a separate bug to fix.
DELETE FROM "zero_workflows" WHERE "type" = 'workflow' AND "agent_id" IS NULL;--> statement-breakpoint

-- 7. Enforce hard 1:N ownership.
ALTER TABLE "zero_workflows" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zero_workflows" ADD CONSTRAINT "zero_workflows_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_zero_workflows_agent" ON "zero_workflows" USING btree ("agent_id","name");--> statement-breakpoint

-- 8. The agent link now lives only on the workflow row.
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_agent_id_zero_agents_id_fk";--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP COLUMN "agent_id";--> statement-breakpoint

-- 9. Drop the junction table.
ALTER TABLE "zero_workflow_agents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "zero_workflow_agents" CASCADE;
