ALTER TABLE "agent_runs" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "runner_heartbeat_generation" bigint;