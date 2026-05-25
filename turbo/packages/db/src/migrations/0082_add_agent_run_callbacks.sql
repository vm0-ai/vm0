-- Agent run callbacks table for webhook notifications on run completion
CREATE TABLE IF NOT EXISTS "agent_run_callbacks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "run_id" uuid NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
    "url" text NOT NULL,
    "encrypted_secret" text NOT NULL,
    "payload" jsonb,
    "status" varchar(20) NOT NULL DEFAULT 'pending',
    "attempts" integer NOT NULL DEFAULT 0,
    "last_attempt_at" timestamp,
    "last_error" text,
    "delivered_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_agent_run_callbacks_run_id" ON "agent_run_callbacks" ("run_id");
CREATE INDEX IF NOT EXISTS "idx_agent_run_callbacks_pending" ON "agent_run_callbacks" ("status") WHERE status = 'pending';
