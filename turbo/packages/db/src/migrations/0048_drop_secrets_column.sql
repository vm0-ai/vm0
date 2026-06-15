-- Drop secrets column from agent_runs table
-- Secrets values are never stored - only secret names for validation
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "secrets";

-- Drop secrets column from agent_sessions table
-- Secrets values are never stored - only secret names for validation
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "secrets";
