-- Add version_id column to images table for image versioning support
-- Each build creates a new version with a unique SHA256 hex identifier (64 chars)

-- Add version_id column (nullable for legacy images)
ALTER TABLE "images" ADD COLUMN "version_id" varchar(64);

-- Drop old unique constraint (userId, alias) to allow multiple versions per alias
DROP INDEX IF EXISTS "idx_images_user_alias";

-- Create new unique constraint allowing multiple versions per alias
-- Note: NULL version_id is allowed for legacy images, so we use a partial unique index
CREATE UNIQUE INDEX "idx_images_scope_alias_version"
  ON "images" ("scope_id", "alias", "version_id")
  WHERE "version_id" IS NOT NULL;

-- Separate unique index for legacy images (where version_id is NULL)
-- This ensures at most one legacy image per (scope_id, alias) pair
CREATE UNIQUE INDEX "idx_images_scope_alias_legacy"
  ON "images" ("scope_id", "alias")
  WHERE "version_id" IS NULL;

-- Add index for latest version queries (order by created_at DESC)
CREATE INDEX "idx_images_latest_lookup"
  ON "images" ("scope_id", "alias", "status", "created_at" DESC);
