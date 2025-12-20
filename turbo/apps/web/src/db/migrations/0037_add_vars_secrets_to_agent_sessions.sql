-- Drop the old template_vars column if it exists
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "template_vars";
--> statement-breakpoint
-- Add vars column for template variables
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "vars" jsonb;
--> statement-breakpoint
-- Add secrets column for sensitive values
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "secrets" jsonb;
