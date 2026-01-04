-- Remove runner-related fields from agent_runs
-- These fields are now in runner_job_queue table

-- Drop the index first
DROP INDEX IF EXISTS "idx_agent_runs_runner_pending";

-- Drop the columns
ALTER TABLE "agent_runs"
  DROP COLUMN IF EXISTS "runner_group",
  DROP COLUMN IF EXISTS "runner_id",
  DROP COLUMN IF EXISTS "claimed_at",
  DROP COLUMN IF EXISTS "execution_context";
