-- Final step of #20101 (parent #20099): remove the legacy automation data
-- layer. The backfill migration 0550 already repointed every mappable
-- historical run at its migrated workflow trigger (verified in production:
-- all external-org runs mapped; the 4,261 unmapped runs are internal-org
-- records whose automation->workflow link was never recorded).

-- Any legacy run that could not be mapped to a workflow trigger behaves as if
-- the deleted automation no longer exists.
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

-- Clear legacy automation metadata from chat messages; mapped messages keep
-- their workflow grouping (aligned by 0550), unmapped ones lose the legacy
-- grouping and render as plain user messages.
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

-- Messages without a run row (orphans) get the same treatment.
UPDATE "chat_messages"
SET
  "automation_id" = NULL,
  "automation_title" = NULL,
  "automation_snapshot" = NULL
WHERE "automation_id" IS NOT NULL
   OR "automation_title" IS NOT NULL
   OR "automation_snapshot" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "zero_runs" DROP COLUMN "automation_id";--> statement-breakpoint
ALTER TABLE "zero_runs" DROP COLUMN "trigger_id";--> statement-breakpoint

DROP TABLE "automation_triggers";--> statement-breakpoint
DROP TABLE "automations";
