-- Create credentials table for storing third-party service credentials
CREATE TABLE "credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope_id" uuid NOT NULL REFERENCES "scopes"("id") ON DELETE CASCADE,
  "name" varchar(255) NOT NULL,
  "encrypted_value" text NOT NULL,
  "description" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Credential name unique within scope
CREATE UNIQUE INDEX "idx_credentials_scope_name" ON "credentials"("scope_id", "name");

-- Index for listing credentials by scope
CREATE INDEX "idx_credentials_scope" ON "credentials"("scope_id");
