ALTER TABLE "agent_sessions" ADD COLUMN "memory_name" varchar(255);--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "memory_snapshot" jsonb;