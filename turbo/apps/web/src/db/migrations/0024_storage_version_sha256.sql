-- Migration: Change storage version IDs from UUID to SHA-256 content hash
-- This enables content-addressable storage with automatic deduplication

-- Step 1: Drop existing foreign key constraint
ALTER TABLE "storages" DROP CONSTRAINT IF EXISTS "storages_head_version_id_storage_versions_id_fk";

-- Step 2: Alter storage_versions.id from uuid to varchar(64)
-- Drop the primary key constraint (named volume_versions_pkey from original table creation)
ALTER TABLE "storage_versions" DROP CONSTRAINT IF EXISTS "volume_versions_pkey";

-- Change the column type and re-add primary key in one step
ALTER TABLE "storage_versions" ALTER COLUMN "id" TYPE varchar(64) USING id::text;
ALTER TABLE "storage_versions" ADD CONSTRAINT "storage_versions_pkey" PRIMARY KEY ("id");

-- Step 3: Alter storages.head_version_id from uuid to varchar(64)
ALTER TABLE "storages" ALTER COLUMN "head_version_id" TYPE varchar(64) USING head_version_id::text;

-- Step 4: Re-add foreign key constraint
ALTER TABLE "storages"
  ADD CONSTRAINT "storages_head_version_id_storage_versions_id_fk"
  FOREIGN KEY ("head_version_id")
  REFERENCES "public"."storage_versions"("id")
  ON DELETE no action ON UPDATE no action;

-- Step 5: Alter storage_versions.storage_id reference (this column stays as uuid, just referencing storages.id)
-- No change needed here as storages.id remains uuid
