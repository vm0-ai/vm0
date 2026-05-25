-- Allow null on agent_compose_version_id to support agent deletion
-- When an agent is deleted, historical runs should be preserved with null version reference
ALTER TABLE "agent_runs" ALTER COLUMN "agent_compose_version_id" DROP NOT NULL;

-- Modify FK constraint to set null on delete
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_agent_compose_version_id_fkey";
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_compose_version_id_fkey"
  FOREIGN KEY ("agent_compose_version_id") REFERENCES "agent_compose_versions"("id") ON DELETE SET NULL;
