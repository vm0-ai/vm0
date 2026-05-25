-- Add scope_id to users table
-- Links users to their personal scope

ALTER TABLE "users" ADD COLUMN "scope_id" uuid REFERENCES "scopes"("id");

-- Create index for scope lookups
CREATE INDEX IF NOT EXISTS "idx_users_scope" ON "users" USING btree ("scope_id");
