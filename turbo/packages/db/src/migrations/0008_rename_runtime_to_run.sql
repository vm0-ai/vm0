-- Rename agent_runtimes table to agent_runs
ALTER TABLE "agent_runtimes" RENAME TO "agent_runs";
--> statement-breakpoint

-- Rename agent_runtime_events table to agent_run_events
ALTER TABLE "agent_runtime_events" RENAME TO "agent_run_events";
--> statement-breakpoint

-- Rename runtime_id column to run_id in agent_run_events table
ALTER TABLE "agent_run_events" RENAME COLUMN "runtime_id" TO "run_id";
