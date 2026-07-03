-- Add scopes table for namespace isolation
-- Phase 1 of scope system implementation (Issue #628)

-- Create scope type enum
CREATE TYPE scope_type AS ENUM ('personal', 'organization', 'system');

-- Create scopes table
CREATE TABLE IF NOT EXISTS "scopes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(64) NOT NULL UNIQUE,
  "type" scope_type NOT NULL DEFAULT 'personal',
  "owner_id" text,
  "display_name" varchar(128),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Create indexes
CREATE INDEX IF NOT EXISTS "idx_scopes_owner" ON "scopes" USING btree ("owner_id");
CREATE INDEX IF NOT EXISTS "idx_scopes_type" ON "scopes" USING btree ("type");

-- Seed vm0 system scope
INSERT INTO "scopes" ("slug", "type", "display_name")
VALUES ('vm0', 'system', 'VM0 System')
ON CONFLICT ("slug") DO NOTHING;
