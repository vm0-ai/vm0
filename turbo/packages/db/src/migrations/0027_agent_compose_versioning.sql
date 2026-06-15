-- Migration: Add immutable versioning to agent_composes
-- This follows the same pattern as storage + storage_versions

-- Step 1: Create agent_compose_versions table with content-addressable SHA-256 hash IDs
CREATE TABLE "agent_compose_versions" (
  "id" VARCHAR(64) PRIMARY KEY,
  "compose_id" UUID NOT NULL REFERENCES "agent_composes"("id") ON DELETE CASCADE,
  "content" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX "idx_agent_compose_versions_compose_id" ON "agent_compose_versions"("compose_id");

-- Step 2: Add head_version_id column to agent_composes
ALTER TABLE "agent_composes" ADD COLUMN "head_version_id" VARCHAR(64);

-- Step 3: Migrate existing data - create versions from existing configs
-- For each existing compose, create a version with SHA-256 hash of the config
-- Note: The hash is computed in the application layer during this migration
-- This SQL just prepares the structure; actual data migration happens in code

-- Step 4: Rename agent_compose_id to agent_compose_version_id in agent_runs
-- First add the new column
ALTER TABLE "agent_runs" ADD COLUMN "agent_compose_version_id" VARCHAR(64);

-- Step 5: Add foreign key constraint to agent_runs
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_compose_version_id_fkey"
  FOREIGN KEY ("agent_compose_version_id") REFERENCES "agent_compose_versions"("id");

-- Step 6: Drop old config column from agent_composes
ALTER TABLE "agent_composes" DROP COLUMN IF EXISTS "config";

-- Step 7: Drop old agent_compose_id column from agent_runs
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "agent_compose_id";
