ALTER TABLE "zero_skills" RENAME TO "zero_workflows";
--> statement-breakpoint
ALTER TABLE "zero_workflows" RENAME CONSTRAINT "zero_skills_pkey" TO "zero_workflows_pkey";
--> statement-breakpoint
ALTER INDEX "idx_zero_skills_org_name" RENAME TO "idx_zero_workflows_org_name";
--> statement-breakpoint
ALTER INDEX "idx_zero_skills_org" RENAME TO "idx_zero_workflows_org";
--> statement-breakpoint
ALTER TABLE "zero_workflows"
  ADD COLUMN "visibility" varchar(16) DEFAULT 'public' NOT NULL,
  ADD COLUMN "owner_user_id" text;
--> statement-breakpoint
UPDATE "zero_workflows"
SET "owner_user_id" = "created_by"
WHERE "owner_user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "zero_workflows"
  ALTER COLUMN "owner_user_id" SET NOT NULL,
  ALTER COLUMN "visibility" SET DEFAULT 'private';
--> statement-breakpoint
CREATE INDEX "idx_zero_workflows_org_owner"
  ON "zero_workflows" ("org_id", "owner_user_id");
--> statement-breakpoint
CREATE TABLE "zero_workflow_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "workflow_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_agents"
  ADD CONSTRAINT "zero_workflow_agents_workflow_id_zero_workflows_id_fk"
  FOREIGN KEY ("workflow_id")
  REFERENCES "zero_workflows"("id")
  ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "zero_workflow_agents"
  ADD CONSTRAINT "zero_workflow_agents_agent_id_zero_agents_id_fk"
  FOREIGN KEY ("agent_id")
  REFERENCES "zero_agents"("id")
  ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflow_agents_workflow_agent"
  ON "zero_workflow_agents" ("workflow_id", "agent_id");
--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_agents_agent"
  ON "zero_workflow_agents" ("org_id", "agent_id");
--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_agents_workflow"
  ON "zero_workflow_agents" ("org_id", "workflow_id");
--> statement-breakpoint
INSERT INTO "zero_workflow_agents" (
  "org_id",
  "workflow_id",
  "agent_id",
  "created_by",
  "created_at"
)
SELECT
  "zero_agents"."org_id",
  "zero_workflows"."id",
  "zero_agents"."id",
  "zero_agents"."owner",
  now()
FROM "zero_agents"
CROSS JOIN LATERAL jsonb_array_elements_text("zero_agents"."custom_skills") AS "skill_names"("name")
INNER JOIN "zero_workflows"
  ON "zero_workflows"."org_id" = "zero_agents"."org_id"
  AND "zero_workflows"."name" = "skill_names"."name"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "zero_agents" DROP COLUMN "custom_skills";
