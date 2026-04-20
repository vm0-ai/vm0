-- Add user_id column to agent_runtimes table
ALTER TABLE "agent_runtimes" ADD COLUMN "user_id" text NOT NULL DEFAULT 'placeholder';
--> statement-breakpoint

-- Remove default after adding column (defaults are just for migration)
ALTER TABLE "agent_runtimes" ALTER COLUMN "user_id" DROP DEFAULT;
