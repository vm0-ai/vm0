-- Create runners table for self-hosted runner registration
CREATE TABLE IF NOT EXISTS "runners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "name" varchar(255) NOT NULL,
  "runner_group" varchar(255) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'offline',
  "last_heartbeat_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Index for looking up runners by group (for job polling)
CREATE INDEX IF NOT EXISTS "idx_runners_runner_group" ON "runners"("runner_group");

-- Unique constraint: user can only have one runner with the same name
CREATE UNIQUE INDEX IF NOT EXISTS "runners_user_id_name_unique" ON "runners"("user_id", "name");
