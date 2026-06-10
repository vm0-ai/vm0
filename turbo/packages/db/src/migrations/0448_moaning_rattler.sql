ALTER TABLE "automation_triggers" DROP COLUMN "retry_started_at";--> statement-breakpoint
-- Refresh the events-first mirror of zero_agent_schedules ahead of the poller
-- cutover (#16847). The 0442 backfill skipped already-mapped rows, and until
-- the runtime mirror-sync shipped, the mirror was a CRUD-time snapshot that
-- drifted on every fire. This migration brings every mapped mirror back to an
-- exact copy of its source schedule and inserts mirrors for any schedule the
-- best-effort dual-write skipped (e.g. transient failures).
--
-- Idempotent and data-only: re-running converges to the same state and no run
-- is created (the live executeDueSchedules$ poller stays the only schedule
-- executor; the trigger poller is dormant). Name collisions with
-- natively-created automations are skipped (ON CONFLICT DO NOTHING) and left
-- for the reconciliation query to surface.

-- 1) Refresh mapped automations from their source schedules.
UPDATE "automations" AS "automation"
SET
  "org_id" = "schedule"."org_id",
  "user_id" = "schedule"."user_id",
  "name" = "schedule"."name",
  "description" = "schedule"."description",
  "instruction" = "schedule"."prompt",
  "append_system_prompt" = "schedule"."append_system_prompt",
  "agent_id" = "schedule"."agent_id",
  "chat_thread_id" = "schedule"."chat_thread_id",
  "enabled" = "schedule"."enabled",
  "updated_at" = "schedule"."updated_at"
FROM "zero_agent_schedules" AS "schedule"
WHERE "automation"."source_schedule_id" = "schedule"."id";--> statement-breakpoint

-- 2) Refresh mapped trigger rows (config + runtime state) from their source
-- schedules.
UPDATE "automation_triggers" AS "trigger"
SET
  "kind" = "schedule"."trigger_type",
  "cron_expression" = "schedule"."cron_expression",
  "at_time" = "schedule"."at_time",
  "interval_seconds" = "schedule"."interval_seconds",
  "timezone" = "schedule"."timezone",
  "next_run_at" = "schedule"."next_run_at",
  "last_run_at" = "schedule"."last_run_at",
  "last_run_id" = "schedule"."last_run_id",
  "consecutive_failures" = "schedule"."consecutive_failures",
  "enabled" = "schedule"."enabled",
  "updated_at" = "schedule"."updated_at"
FROM "automations" AS "automation"
JOIN "zero_agent_schedules" AS "schedule"
  ON "schedule"."id" = "automation"."source_schedule_id"
WHERE "trigger"."automation_id" = "automation"."id";--> statement-breakpoint

-- 3) Mirror any schedule still unmapped (0442 ran before some schedules
-- existed, and the dual-write is best-effort). Same shape as 0442 minus
-- retry_started_at (dropped in 0445) plus append_system_prompt (added 0444).
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
    "append_system_prompt",
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
    "schedule"."append_system_prompt",
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
  ON CONFLICT DO NOTHING
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
  "schedule"."enabled",
  "schedule"."created_at",
  "schedule"."updated_at"
FROM "inserted_automations" AS "inserted"
JOIN "zero_agent_schedules" AS "schedule"
  ON "schedule"."id" = "inserted"."schedule_id";
