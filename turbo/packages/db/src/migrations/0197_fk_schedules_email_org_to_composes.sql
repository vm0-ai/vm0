-- Migration: Re-point FKs from zero_agents to agent_composes
-- zero_agents is optional metadata; agent_composes is the authoritative table.
-- Agents created via `vm0 compose` may not have a zero_agents row,
-- so downstream FKs must reference agent_composes directly.

-- 1. zero_agent_schedules.agent_id
ALTER TABLE "zero_agent_schedules"
  DROP CONSTRAINT IF EXISTS "zero_agent_schedules_agent_id_zero_agents_id_fk";
ALTER TABLE "zero_agent_schedules"
  ADD CONSTRAINT "zero_agent_schedules_agent_id_agent_composes_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "agent_composes"("id") ON DELETE CASCADE;

-- 2. email_thread_sessions.agent_id
ALTER TABLE "email_thread_sessions"
  DROP CONSTRAINT IF EXISTS "email_thread_sessions_agent_id_zero_agents_id_fk";
ALTER TABLE "email_thread_sessions"
  ADD CONSTRAINT "email_thread_sessions_agent_id_agent_composes_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "agent_composes"("id") ON DELETE CASCADE;

-- 3. org_metadata.default_agent_id
ALTER TABLE "org_metadata"
  DROP CONSTRAINT IF EXISTS "org_metadata_default_agent_id_zero_agents_id_fk";
ALTER TABLE "org_metadata"
  ADD CONSTRAINT "org_metadata_default_agent_id_agent_composes_id_fk"
  FOREIGN KEY ("default_agent_id") REFERENCES "agent_composes"("id") ON DELETE SET NULL;
