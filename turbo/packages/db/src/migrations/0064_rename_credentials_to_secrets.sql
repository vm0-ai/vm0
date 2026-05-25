-- Phase 2: Rename credentials table to secrets
-- This migration renames the credentials table and all related references

-- Step 1: Rename the credentials table to secrets
ALTER TABLE "credentials" RENAME TO "secrets";--> statement-breakpoint

-- Step 2: Rename the credential_id column in model_providers to secret_id
ALTER TABLE "model_providers" RENAME COLUMN "credential_id" TO "secret_id";--> statement-breakpoint

-- Step 3: Rename indexes
ALTER INDEX "idx_credentials_scope_name" RENAME TO "idx_secrets_scope_name";--> statement-breakpoint
ALTER INDEX "idx_credentials_scope" RENAME TO "idx_secrets_scope";--> statement-breakpoint
ALTER INDEX "idx_credentials_type" RENAME TO "idx_secrets_type";--> statement-breakpoint

-- Step 4: Clean up slack_bindings encrypted_secrets column (feature not live, no data)
DELETE FROM "slack_bindings";--> statement-breakpoint
ALTER TABLE "slack_bindings" DROP COLUMN IF EXISTS "encrypted_secrets";
