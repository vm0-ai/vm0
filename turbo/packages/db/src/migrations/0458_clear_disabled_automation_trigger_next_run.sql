-- #17546: disabling an automation used to leave its time triggers permanently
-- due (next_run_at in the past, never claimable), starving the poller batch.
-- The code fix clears next_run_at on disable; this retires the zombies that
-- already accumulated. Idempotent.
UPDATE "automation_triggers" AS "t"
SET "next_run_at" = NULL, "updated_at" = now()
FROM "automations" AS "a"
WHERE "t"."automation_id" = "a"."id"
  AND "a"."enabled" = false
  AND "t"."next_run_at" IS NOT NULL;
