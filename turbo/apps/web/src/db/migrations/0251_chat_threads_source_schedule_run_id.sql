-- Replace the auto-appended system prompt with a pointer to the source
-- scheduled run. The prompt is now built on demand at first-run time using
-- this run ID, instead of being persisted and re-applied to every run.
ALTER TABLE "chat_threads" DROP COLUMN IF EXISTS "append_system_prompt";
ALTER TABLE "chat_threads" ADD COLUMN "source_schedule_run_id" uuid;
