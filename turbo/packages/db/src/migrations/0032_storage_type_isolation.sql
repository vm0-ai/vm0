-- Migration: Add type to unique constraint for storage isolation
-- This allows volumes and artifacts to have the same name under the same user

-- Step 1: Drop existing unique index on (user_id, name)
DROP INDEX IF EXISTS "idx_storages_user_name";
--> statement-breakpoint

-- Step 2: Create new unique index on (user_id, name, type)
-- This allows same name across different types (volume vs artifact)
CREATE UNIQUE INDEX "idx_storages_user_name_type" ON "storages" ("user_id", "name", "type");
--> statement-breakpoint

-- Step 3: Update s3_prefix to include type for existing storages
-- Format changes from: userId/storageName to: userId/type/storageName
UPDATE "storages"
SET "s3_prefix" = "user_id" || '/' || "type" || '/' || "name"
WHERE "s3_prefix" = "user_id" || '/' || "name";
--> statement-breakpoint

-- Step 4: Update s3_key in storage_versions to include type
-- Format changes from: userId/storageName/versionId to: userId/type/storageName/versionId
UPDATE "storage_versions" sv
SET "s3_key" = s."user_id" || '/' || s."type" || '/' || s."name" || '/' || sv."id"
FROM "storages" s
WHERE sv."storage_id" = s."id"
  AND sv."s3_key" = s."user_id" || '/' || s."name" || '/' || sv."id";
