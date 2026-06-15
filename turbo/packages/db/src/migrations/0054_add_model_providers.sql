-- Add type column to credentials table
ALTER TABLE "credentials" ADD COLUMN "type" varchar(50) NOT NULL DEFAULT 'user';

-- Add index for filtering by type
CREATE INDEX "idx_credentials_type" ON "credentials"("type");

-- Create model_providers table
CREATE TABLE "model_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope_id" uuid NOT NULL REFERENCES "scopes"("id") ON DELETE CASCADE,
  "type" varchar(50) NOT NULL,
  "credential_id" uuid NOT NULL REFERENCES "credentials"("id") ON DELETE CASCADE,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- One provider per type per user
CREATE UNIQUE INDEX "idx_model_providers_scope_type" ON "model_providers"("scope_id", "type");

-- Index for listing by scope
CREATE INDEX "idx_model_providers_scope" ON "model_providers"("scope_id");

-- Index for credential lookup
CREATE INDEX "idx_model_providers_credential" ON "model_providers"("credential_id");
