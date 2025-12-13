-- Revert: Reverse the storage_name_256 migration
-- This migration reverts changes from the original 0033_storage_name_256.sql
-- Made idempotent to handle both fresh databases and production databases

-- Revert storage name column length back to 64 (only if it's currently 256)
DO $$
DECLARE
  current_length integer;
BEGIN
  SELECT character_maximum_length INTO current_length
  FROM information_schema.columns
  WHERE table_name = 'storages' AND column_name = 'name';

  IF current_length = 256 THEN
    ALTER TABLE "storages" ALTER COLUMN "name" TYPE varchar(64);
  END IF;
END $$;
