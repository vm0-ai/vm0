-- Drop unused display_name column from scopes table
ALTER TABLE "scopes" DROP COLUMN IF EXISTS "display_name";
