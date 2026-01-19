-- Add secret_names column to agent_runs (secret names for validation, values never stored)
ALTER TABLE "agent_runs" ADD COLUMN "secret_names" jsonb;

-- Add secret_names column to agent_sessions (secret names for validation, values never stored)
ALTER TABLE "agent_sessions" ADD COLUMN "secret_names" jsonb;
