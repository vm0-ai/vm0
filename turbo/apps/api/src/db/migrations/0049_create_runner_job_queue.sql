-- Create runner_job_queue table for temporary storage of runner jobs with encrypted secrets
-- Records are deleted after job completion

CREATE TABLE "runner_job_queue" (
  "run_id" uuid PRIMARY KEY REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "runner_group" varchar(255) NOT NULL,
  "claimed_at" timestamp,
  "execution_context" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp NOT NULL
);

-- Index for polling unclaimed jobs by group
CREATE INDEX "runner_job_queue_group_unclaimed_idx" ON "runner_job_queue"("runner_group")
  WHERE "claimed_at" IS NULL;

-- Index for TTL cleanup
CREATE INDEX "runner_job_queue_expires_at_idx" ON "runner_job_queue"("expires_at");
