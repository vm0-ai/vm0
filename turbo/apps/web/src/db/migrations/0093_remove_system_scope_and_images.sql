-- Remove system scope type and drop images table
-- Issue: #3396 - vm0 becomes a regular organization, custom images removed

-- 1. Delete the seeded vm0 system scope (admin will recreate as org via CLI)
DELETE FROM "scopes" WHERE "slug" = 'vm0' AND "type" = 'system';

-- 2. Drop images table (custom image feature fully removed)
DROP TABLE IF EXISTS "images" CASCADE;

-- 3. Replace scope_type enum: remove 'system' value
-- PostgreSQL does not support ALTER TYPE REMOVE VALUE, so we recreate
CREATE TYPE "scope_type_new" AS ENUM ('personal', 'organization');
ALTER TABLE "scopes" ALTER COLUMN "type" TYPE "scope_type_new" USING ("type"::text::"scope_type_new");
DROP TYPE "scope_type";
ALTER TYPE "scope_type_new" RENAME TO "scope_type";
