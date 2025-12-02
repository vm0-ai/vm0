-- Add environment column to agent_runs for storing resolved environment variables
-- This allows checkpoint resumption to restore the exact environment state
ALTER TABLE "agent_runs" ADD COLUMN "environment" jsonb;
