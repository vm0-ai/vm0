-- Drop foreign key constraint
ALTER TABLE "agent_configs" DROP CONSTRAINT IF EXISTS "agent_configs_api_key_id_api_keys_id_fk";
--> statement-breakpoint

-- Drop api_key_id column
ALTER TABLE "agent_configs" DROP COLUMN IF EXISTS "api_key_id";
--> statement-breakpoint

-- Add user_id column
ALTER TABLE "agent_configs" ADD COLUMN "user_id" text NOT NULL DEFAULT 'placeholder';
--> statement-breakpoint

-- Remove default after adding column (defaults are just for migration)
ALTER TABLE "agent_configs" ALTER COLUMN "user_id" DROP DEFAULT;
