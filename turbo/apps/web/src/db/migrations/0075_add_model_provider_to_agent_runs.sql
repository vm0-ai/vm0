-- Add model_provider column to agent_runs table
-- This tracks which model provider was used for each run

ALTER TABLE agent_runs ADD COLUMN model_provider VARCHAR(255);
