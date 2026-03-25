-- Add model_preferences column to org_members_metadata
-- Stores per-agent model provider preferences as JSON: { "agent-id": "provider-type" }
ALTER TABLE "org_members_metadata" ADD COLUMN "model_preferences" jsonb DEFAULT '{}'::jsonb;
