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

-- Once a message's run points at a workflow trigger, keep its grouping aligned.
UPDATE "chat_messages" "cm"
SET
  "run_group_id" = "zr"."workflow_trigger_id"
FROM "zero_runs" "zr"
WHERE "cm"."run_id" = "zr"."id"
  AND "zr"."workflow_trigger_id" IS NOT NULL
  AND "cm"."run_group_id" IS DISTINCT FROM "zr"."workflow_trigger_id";--> statement-breakpoint

-- Any legacy run that could not be mapped to a workflow trigger should behave
-- as if the deleted automation no longer exists.
UPDATE "zero_runs"
SET
  "automation_id" = NULL,
  "trigger_id" = NULL,
  "run_group_id" = CASE
    WHEN "workflow_trigger_id" IS NULL THEN NULL
    ELSE "run_group_id"
  END
WHERE "automation_id" IS NOT NULL
   OR "trigger_id" IS NOT NULL;--> statement-breakpoint

UPDATE "chat_messages" "cm"
SET
  "automation_id" = NULL,
  "automation_title" = NULL,
  "automation_snapshot" = NULL,
  "run_group_id" = CASE
    WHEN "zr"."workflow_trigger_id" IS NULL THEN NULL
    ELSE "cm"."run_group_id"
  END
FROM "zero_runs" "zr"
WHERE "cm"."run_id" = "zr"."id"
  AND ("cm"."automation_id" IS NOT NULL
    OR "cm"."automation_title" IS NOT NULL
    OR "cm"."automation_snapshot" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "zero_runs" DROP COLUMN "automation_id";--> statement-breakpoint
ALTER TABLE "zero_runs" DROP COLUMN "trigger_id";--> statement-breakpoint

DROP TABLE "automation_triggers";--> statement-breakpoint
DROP TABLE "automations";
