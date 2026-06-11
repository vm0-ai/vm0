-- Backfill every existing zero_agent_schedules row into the events-first tables
-- (automations + a time automation_triggers row), so that at the later, gated
-- cutover the new tables are a complete, live mirror of zero_agent_schedules.
--
-- Idempotent: schedules already mapped (an automations row carrying their id in
-- source_schedule_id) are skipped, so a re-run inserts nothing. This is a
-- data-only copy carrying over enabled state + runtime fields; it does NOT
-- create any run (the live executeDueSchedules$ poller stays the only schedule
-- executor; the trigger poller is dormant).
WITH unmapped_schedules AS MATERIALIZED (
  SELECT
    "schedule"."id" AS "schedule_id",
    gen_random_uuid() AS "automation_id"
  FROM "zero_agent_schedules" AS "schedule"
  WHERE NOT EXISTS (
    SELECT 1
    FROM "automations" AS "existing"
    WHERE "existing"."source_schedule_id" = "schedule"."id"
  )
  FOR UPDATE
),
inserted_automations AS (
  INSERT INTO "automations" (
    "id",
    "org_id",
    "user_id",
    "name",
    "description",
    "instruction",
    "agent_id",
    "chat_thread_id",
    "interpreter_kind",
    "enabled",
    "source_schedule_id",
    "created_at",
    "updated_at"
  )
  SELECT
    "unmapped"."automation_id",
    "schedule"."org_id",
    "schedule"."user_id",
    "schedule"."name",
    "schedule"."description",
    "schedule"."prompt",
    "schedule"."agent_id",
    "schedule"."chat_thread_id",
    'time',
    "schedule"."enabled",
    "schedule"."id",
    "schedule"."created_at",
    "schedule"."updated_at"
  FROM "unmapped_schedules" AS "unmapped"
  JOIN "zero_agent_schedules" AS "schedule"
    ON "schedule"."id" = "unmapped"."schedule_id"
  RETURNING "id" AS "automation_id", "source_schedule_id" AS "schedule_id"
)
INSERT INTO "automation_triggers" (
  "automation_id",
  "kind",
  "cron_expression",
  "at_time",
  "interval_seconds",
  "timezone",
  "next_run_at",
  "last_run_at",
  "last_run_id",
  "consecutive_failures",
  "retry_started_at",
  "enabled",
  "created_at",
  "updated_at"
)
SELECT
  "inserted"."automation_id",
  "schedule"."trigger_type",
  "schedule"."cron_expression",
  "schedule"."at_time",
  "schedule"."interval_seconds",
  "schedule"."timezone",
  "schedule"."next_run_at",
  "schedule"."last_run_at",
  "schedule"."last_run_id",
  "schedule"."consecutive_failures",
  "schedule"."retry_started_at",
  "schedule"."enabled",
  "schedule"."created_at",
  "schedule"."updated_at"
FROM "inserted_automations" AS "inserted"
JOIN "zero_agent_schedules" AS "schedule"
  ON "schedule"."id" = "inserted"."schedule_id";
