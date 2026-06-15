ALTER TABLE "agent_runs" ADD COLUMN "last_heartbeat_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_runs_status_heartbeat" ON "agent_runs" USING btree ("status","last_heartbeat_at");
