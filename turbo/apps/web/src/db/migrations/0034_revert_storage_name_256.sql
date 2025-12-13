-- Revert: Reverse the storage_name_256 migration
-- This migration reverts changes from the original 0033_storage_name_256.sql

-- Revert storage name column length back to 64
-- Note: This may fail if there are existing values longer than 64 characters
ALTER TABLE "storages" ALTER COLUMN "name" TYPE varchar(64);
