-- The final retirement of zero_agent_schedules (#16847): every business path
-- moved to automations + automation_triggers at the phase-3 cutover; this
-- migration removes the table and its remaining links.

-- 1) Upgrade historical run provenance before the mapping disappears: runs
-- recorded before the cutover carry only schedule_id — point them at the
-- mirrored automation so per-automation history (usage insights, footers)
-- spans the cutover. Idempotent data-only update.
UPDATE "zero_runs" AS "zr"
SET "automation_id" = "a"."id"
FROM "automations" AS "a"
WHERE "a"."source_schedule_id" = "zr"."schedule_id"
  AND "zr"."schedule_id" IS NOT NULL
  AND "zr"."automation_id" IS NULL;--> statement-breakpoint

-- 2) Detach historical columns (kept for record, no longer FK-bound).
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_schedule_id_zero_agent_schedules_id_fk";--> statement-breakpoint
ALTER TABLE "zero_runs" DROP CONSTRAINT "zero_runs_schedule_id_zero_agent_schedules_id_fk";--> statement-breakpoint

-- 3) Drop the legacy table and the migration-provenance column.
ALTER TABLE "zero_agent_schedules" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "zero_agent_schedules" CASCADE;--> statement-breakpoint
DROP INDEX "idx_automations_source_schedule";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "source_schedule_id";
