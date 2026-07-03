-- Expand e2b_alias column to 256 characters
-- New format: scope-{scopeId}-image-{name}-version-{hash}
-- Requires more space than the previous 128 character limit

ALTER TABLE "images" ALTER COLUMN "e2b_alias" TYPE varchar(256);
