-- Rename agent_configs table to agent_composes
ALTER TABLE "agent_configs" RENAME TO "agent_composes";

-- Rename index
ALTER INDEX "idx_agent_configs_user_name" RENAME TO "idx_agent_composes_user_name";

-- Rename column in agent_runs
ALTER TABLE "agent_runs" RENAME COLUMN "agent_config_id" TO "agent_compose_id";

-- Rename column in agent_sessions
ALTER TABLE "agent_sessions" RENAME COLUMN "agent_config_id" TO "agent_compose_id";

-- Rename column in checkpoints
ALTER TABLE "checkpoints" RENAME COLUMN "agent_config_snapshot" TO "agent_compose_snapshot";
