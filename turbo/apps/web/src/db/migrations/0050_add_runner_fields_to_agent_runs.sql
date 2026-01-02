-- Add runner-related fields to agent_runs for self-hosted runner support
ALTER TABLE "agent_runs"
  ADD COLUMN "runner_group" varchar(255),
  ADD COLUMN "runner_id" uuid REFERENCES "runners"("id"),
  ADD COLUMN "claimed_at" timestamp;

-- Index for efficient job queue polling
-- Only indexes pending runs that are assigned to a runner group
CREATE INDEX IF NOT EXISTS "idx_agent_runs_runner_pending" ON "agent_runs"("runner_group", "status")
  WHERE "status" = 'pending' AND "runner_group" IS NOT NULL;
