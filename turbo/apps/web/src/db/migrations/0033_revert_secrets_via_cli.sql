-- Revert: Reverse the secrets_via_cli migration
-- This migration reverts changes from the original 0033_secrets_via_cli.sql

-- Recreate user_secrets table
CREATE TABLE IF NOT EXISTS "user_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "name" varchar(255) NOT NULL,
  "encrypted_value" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_secrets_user_name" ON "user_secrets" USING btree ("user_id", "name");
CREATE INDEX IF NOT EXISTS "idx_user_secrets_user_id" ON "user_secrets" USING btree ("user_id");

-- Drop secrets columns from agent_runs and agent_sessions
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "secrets";
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "secrets";

-- Rename vars back to template_vars in agent_runs
ALTER TABLE "agent_runs" RENAME COLUMN "vars" TO "template_vars";

-- Rename vars back to template_vars in agent_sessions
ALTER TABLE "agent_sessions" RENAME COLUMN "vars" TO "template_vars";
