ALTER TABLE "zero_workflow_triggers" ADD COLUMN "unattended_connector_refs" jsonb;

UPDATE "zero_workflow_triggers"
SET "unattended_connector_refs" = COALESCE(
  (
    SELECT jsonb_agg(DISTINCT "user_connectors"."connector_type")
    FROM "zero_workflows"
    INNER JOIN "user_connectors"
      ON "user_connectors"."org_id" = "zero_workflows"."org_id"
      AND "user_connectors"."agent_id" = "zero_workflows"."agent_id"
      AND "user_connectors"."user_id" = "zero_workflow_triggers"."owner_user_id"
    WHERE "zero_workflows"."id" = "zero_workflow_triggers"."workflow_id"
      AND "zero_workflows"."org_id" = "zero_workflow_triggers"."org_id"
  ),
  '[]'::jsonb
)
WHERE "unattended_connector_refs" IS NULL;
