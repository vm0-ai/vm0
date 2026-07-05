-- Legacy schedule automations that were migrated to workflows reuse both ids:
-- automations.id == zero_workflows.id and automation_triggers.id ==
-- zero_workflow_triggers.id. Repoint historical runs to the workflow trigger so
-- chat history renders through workflowSnapshot instead of the retired
-- automation metadata.
WITH "mapped_legacy_runs" AS (
  SELECT
    "zr"."id" AS "run_id",
    "zwt"."id" AS "workflow_trigger_id"
  FROM "zero_runs" "zr"
  JOIN "automation_triggers" "t"
    ON "t"."id" = "zr"."trigger_id"
  JOIN "zero_workflow_triggers" "zwt"
    ON "zwt"."id" = "t"."id"
  JOIN "zero_workflows" "zw"
    ON "zw"."id" = "zwt"."workflow_id"
    AND "zw"."id" = "t"."automation_id"
  WHERE "zr"."workflow_trigger_id" IS NULL
    AND "zr"."trigger_id" IS NOT NULL
  UNION
  SELECT
    "zr"."id" AS "run_id",
    "zwt"."id" AS "workflow_trigger_id"
  FROM "zero_runs" "zr"
  JOIN "automation_triggers" "t"
    ON "t"."automation_id" = "zr"."automation_id"
  JOIN "zero_workflow_triggers" "zwt"
    ON "zwt"."id" = "t"."id"
  JOIN "zero_workflows" "zw"
    ON "zw"."id" = "zwt"."workflow_id"
    AND "zw"."id" = "zr"."automation_id"
  WHERE "zr"."workflow_trigger_id" IS NULL
    AND "zr"."automation_id" IS NOT NULL
)
UPDATE "zero_runs" "zr"
SET
  "workflow_trigger_id" = "mapped"."workflow_trigger_id",
  "run_group_id" = "mapped"."workflow_trigger_id",
  "trigger_source" = CASE
    WHEN "zr"."trigger_source" = 'automation' THEN 'workflow-schedule'
    ELSE "zr"."trigger_source"
  END,
  "automation_id" = NULL,
  "trigger_id" = NULL
FROM "mapped_legacy_runs" "mapped"
WHERE "zr"."id" = "mapped"."run_id";--> statement-breakpoint

-- Once a message's run points at a workflow trigger, the API can synthesize
-- workflowSnapshot dynamically. Clear legacy automation metadata so the client
-- uses the workflow message renderer and links to the workflow detail page.
UPDATE "chat_messages" "cm"
SET
  "run_group_id" = "zr"."workflow_trigger_id",
  "automation_id" = NULL,
  "automation_title" = NULL,
  "automation_snapshot" = NULL
FROM "zero_runs" "zr"
WHERE "cm"."run_id" = "zr"."id"
  AND "zr"."workflow_trigger_id" IS NOT NULL
  AND (
    "cm"."automation_id" IS NOT NULL
    OR "cm"."automation_title" IS NOT NULL
    OR "cm"."automation_snapshot" IS NOT NULL
  );--> statement-breakpoint

-- Delete only legacy automation rows that have a corresponding migrated
-- workflow trigger. Unmapped legacy rows are kept as inert historical fallback
-- data instead of being blindly purged.
DELETE FROM "automations" "a"
USING "automation_triggers" "t", "zero_workflow_triggers" "zwt", "zero_workflows" "zw"
WHERE "t"."automation_id" = "a"."id"
  AND "zwt"."id" = "t"."id"
  AND "zw"."id" = "zwt"."workflow_id"
  AND "zw"."id" = "a"."id";--> statement-breakpoint

UPDATE "automation_triggers"
SET "enabled" = false,
    "updated_at" = now()
WHERE "enabled" = true;--> statement-breakpoint

UPDATE "automations"
SET "enabled" = false,
    "updated_at" = now()
WHERE "enabled" = true;
