-- Reconciliation check for the schedule → automation mirror (#16847).
--
-- Run against production (read-only) as the gate before flipping the live
-- cron route from executeDueSchedules$ to executeDueTriggers$: every query
-- below must return ZERO rows. Any output means the mirror has drifted from
-- zero_agent_schedules and the flip must wait (re-run the 0446 refresh or fix
-- the divergence first).
--
--   psql "$READONLY_PROD_DATABASE_URL" \
--     -f packages/db/scripts/reconcile-schedule-automation-mirror.sql

-- 1) Schedules with no mirror at all (dual-write skipped them, e.g. a name
-- collision with a natively-created automation).
SELECT
  'unmapped_schedule' AS "issue",
  "schedule"."id" AS "schedule_id",
  "schedule"."name" AS "schedule_name",
  NULL::uuid AS "trigger_id"
FROM "zero_agent_schedules" AS "schedule"
WHERE NOT EXISTS (
  SELECT 1
  FROM "automations" AS "automation"
  WHERE "automation"."source_schedule_id" = "schedule"."id"
);

-- 2) Mirrored automations whose identity/intent fields diverge from the
-- source schedule.
SELECT
  'automation_drift' AS "issue",
  "schedule"."id" AS "schedule_id",
  "schedule"."name" AS "schedule_name",
  NULL::uuid AS "trigger_id"
FROM "automations" AS "automation"
JOIN "zero_agent_schedules" AS "schedule"
  ON "schedule"."id" = "automation"."source_schedule_id"
WHERE "automation"."name" IS DISTINCT FROM "schedule"."name"
   OR "automation"."instruction" IS DISTINCT FROM "schedule"."prompt"
   OR "automation"."append_system_prompt" IS DISTINCT FROM "schedule"."append_system_prompt"
   OR "automation"."agent_id" IS DISTINCT FROM "schedule"."agent_id"
   OR "automation"."chat_thread_id" IS DISTINCT FROM "schedule"."chat_thread_id"
   OR "automation"."enabled" IS DISTINCT FROM "schedule"."enabled";

-- 3) Mirrored trigger rows whose config or runtime state diverges from the
-- source schedule — the fields the poller flip depends on.
SELECT
  'trigger_drift' AS "issue",
  "schedule"."id" AS "schedule_id",
  "schedule"."name" AS "schedule_name",
  "trigger"."id" AS "trigger_id"
FROM "automations" AS "automation"
JOIN "zero_agent_schedules" AS "schedule"
  ON "schedule"."id" = "automation"."source_schedule_id"
JOIN "automation_triggers" AS "trigger"
  ON "trigger"."automation_id" = "automation"."id"
WHERE "trigger"."kind" IS DISTINCT FROM "schedule"."trigger_type"
   OR "trigger"."cron_expression" IS DISTINCT FROM "schedule"."cron_expression"
   OR "trigger"."at_time" IS DISTINCT FROM "schedule"."at_time"
   OR "trigger"."interval_seconds" IS DISTINCT FROM "schedule"."interval_seconds"
   OR "trigger"."timezone" IS DISTINCT FROM "schedule"."timezone"
   OR "trigger"."next_run_at" IS DISTINCT FROM "schedule"."next_run_at"
   OR "trigger"."last_run_id" IS DISTINCT FROM "schedule"."last_run_id"
   OR "trigger"."consecutive_failures" IS DISTINCT FROM "schedule"."consecutive_failures"
   OR "trigger"."enabled" IS DISTINCT FROM "schedule"."enabled";

-- 4) Mirrored automations missing their trigger row (broken mirror shape).
SELECT
  'missing_trigger' AS "issue",
  "schedule"."id" AS "schedule_id",
  "schedule"."name" AS "schedule_name",
  NULL::uuid AS "trigger_id"
FROM "automations" AS "automation"
JOIN "zero_agent_schedules" AS "schedule"
  ON "schedule"."id" = "automation"."source_schedule_id"
WHERE NOT EXISTS (
  SELECT 1
  FROM "automation_triggers" AS "trigger"
  WHERE "trigger"."automation_id" = "automation"."id"
);
