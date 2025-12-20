-- Increase image alias column from 64 to 256 characters
-- This allows longer image names for better flexibility
ALTER TABLE "images" ALTER COLUMN "alias" TYPE varchar(256);
