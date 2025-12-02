-- Sandbox Metrics table for storing resource usage from E2B sandboxes
CREATE TABLE IF NOT EXISTS "sandbox_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "timestamp" timestamp NOT NULL,
  "cpu_used_pct" real NOT NULL,
  "mem_used" bigint NOT NULL,
  "mem_total" bigint NOT NULL,
  "disk_used" bigint NOT NULL,
  "disk_total" bigint NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Index for querying metrics by run
CREATE INDEX IF NOT EXISTS "idx_sandbox_metrics_run_id" ON "sandbox_metrics"("run_id");

-- Index for time-range queries
CREATE INDEX IF NOT EXISTS "idx_sandbox_metrics_timestamp" ON "sandbox_metrics"("run_id", "timestamp");
