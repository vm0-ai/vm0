-- Add agentComposeVersionId and volumeVersions to agent_sessions
-- These fields preserve the execution context at session creation for reproducibility

ALTER TABLE "agent_sessions"
  ADD COLUMN "agent_compose_version_id" varchar(255),
  ADD COLUMN "volume_versions" jsonb;
