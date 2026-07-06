-- Phase B step 1 of #20101 (parent #20099): repoint historical legacy-automation
-- runs at their migrated workflow triggers. Purely additive — automation_id /
-- trigger_id and chat_messages automation metadata are left in place so this
-- migration is fully reversible; clearing and table drops land separately once
-- the backfill is verified.
--
-- Two mapping paths:
--   1. Same-id reuse: the #20033 global cutover created zero_workflows /
--      zero_workflow_triggers rows reusing automations.id / automation_triggers.id.
--   2. Provenance: the vm0 internal org was pre-migrated (Phase 2, 2026-06-28)
--      with NEW workflow ids recorded in automations.migrated_to_workflow_id
--      (#19980). Runs map to the earliest trigger of that workflow.
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
  UNION
  SELECT
    "zr"."id" AS "run_id",
    "zwt"."id" AS "workflow_trigger_id"
  FROM "zero_runs" "zr"
  JOIN "automations" "a"
    ON "a"."id" = "zr"."automation_id"
  JOIN "zero_workflows" "zw"
    ON "zw"."id" = "a"."migrated_to_workflow_id"
  JOIN LATERAL (
    SELECT "id"
    FROM "zero_workflow_triggers"
    WHERE "workflow_id" = "zw"."id"
    ORDER BY "created_at" ASC
    LIMIT 1
  ) "zwt" ON TRUE
  WHERE "zr"."workflow_trigger_id" IS NULL
    AND "zr"."automation_id" IS NOT NULL
    AND "a"."migrated_to_workflow_id" IS NOT NULL
),
"deduped" AS (
  SELECT DISTINCT ON ("run_id") "run_id", "workflow_trigger_id"
  FROM "mapped_legacy_runs"
  ORDER BY "run_id", "workflow_trigger_id"
)
UPDATE "zero_runs" "zr"
SET
  "workflow_trigger_id" = "mapped"."workflow_trigger_id",
  "run_group_id" = "mapped"."workflow_trigger_id",
  "trigger_source" = CASE
    WHEN "zr"."trigger_source" = 'automation' THEN 'workflow-schedule'
    ELSE "zr"."trigger_source"
  END
FROM "deduped" "mapped"
WHERE "zr"."id" = "mapped"."run_id";--> statement-breakpoint

-- Keep message grouping aligned with the repointed runs.
UPDATE "chat_messages" "cm"
SET
  "run_group_id" = "zr"."workflow_trigger_id"
FROM "zero_runs" "zr"
WHERE "cm"."run_id" = "zr"."id"
  AND "zr"."workflow_trigger_id" IS NOT NULL
  AND "cm"."run_group_id" IS DISTINCT FROM "zr"."workflow_trigger_id";
