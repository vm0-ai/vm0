-- Add auth_method column for multi-auth providers (like aws-bedrock)
-- Make credential_id nullable for multi-auth providers that have multiple credentials
ALTER TABLE model_providers ADD COLUMN IF NOT EXISTS auth_method VARCHAR(50);
ALTER TABLE model_providers ALTER COLUMN credential_id DROP NOT NULL;
