-- Agent run events local storage (DB fallback when Axiom is not configured)
CREATE TABLE IF NOT EXISTS "agent_run_events_local" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "run_id" uuid NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
    "sequence_number" integer NOT NULL,
    "event_type" text NOT NULL,
    "event_data" jsonb NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_agent_run_events_local_run_id" ON "agent_run_events_local" ("run_id");
CREATE INDEX IF NOT EXISTS "idx_agent_run_events_local_run_seq" ON "agent_run_events_local" ("run_id", "sequence_number");
