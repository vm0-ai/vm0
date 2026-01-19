-- Rename template_vars to vars in agent_runs
ALTER TABLE "agent_runs" RENAME COLUMN "template_vars" TO "vars";

-- Add secrets column to agent_runs (encrypted per-value)
ALTER TABLE "agent_runs" ADD COLUMN "secrets" jsonb;

-- Rename template_vars to vars in agent_sessions
ALTER TABLE "agent_sessions" RENAME COLUMN "template_vars" TO "vars";

-- Add secrets column to agent_sessions (encrypted per-value)
ALTER TABLE "agent_sessions" ADD COLUMN "secrets" jsonb;

-- Drop user_secrets table (secrets now stored in runs/sessions)
DROP TABLE IF EXISTS "user_secrets";
