-- Create api_tokens table for Public API v1
CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "token_hash" text UNIQUE NOT NULL,
  "token_prefix" text NOT NULL,
  "scopes" text NOT NULL,
  "last_used_at" timestamp,
  "expires_at" timestamp,
  "revoked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS "api_tokens_user_id_idx" ON "api_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "api_tokens_token_hash_idx" ON "api_tokens" ("token_hash");
