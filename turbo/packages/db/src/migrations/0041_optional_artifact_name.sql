-- Migration: Make artifact-related columns nullable
-- This allows agent runs without artifact storage while maintaining
-- checkpoint and session continuation capability.

-- Make artifact_name nullable in agent_sessions table
ALTER TABLE agent_sessions ALTER COLUMN artifact_name DROP NOT NULL;

-- Make artifact_snapshot nullable in checkpoints table
ALTER TABLE checkpoints ALTER COLUMN artifact_snapshot DROP NOT NULL;
