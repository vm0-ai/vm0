-- Revert: Decrease storage name column length back to 64
-- This reverts 0034_storage_name_256.sql
-- Note: This will fail if any storage names exceed 64 characters

ALTER TABLE "storages" ALTER COLUMN "name" TYPE varchar(64);
