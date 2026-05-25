ALTER TABLE "agent_runs" ADD COLUMN "session_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_agent_runs_session" ON "agent_runs" USING btree ("session_id");