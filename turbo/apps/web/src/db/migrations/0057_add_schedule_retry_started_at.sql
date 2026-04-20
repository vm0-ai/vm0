-- Add retry_started_at to track when concurrency retry cycle began
-- This enables automatic retry of scheduled runs that fail due to concurrency limits
ALTER TABLE "agent_schedules" ADD COLUMN "retry_started_at" timestamp;
