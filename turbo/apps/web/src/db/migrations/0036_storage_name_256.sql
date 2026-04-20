-- Migration: Increase storage name column length for system volumes
-- System volumes use naming convention: system-prompt@{name} and system-skill@{owner}/{repo}/tree/{branch}/{path}
-- These names can exceed 64 characters, so we increase to 256

ALTER TABLE "storages" ALTER COLUMN "name" TYPE varchar(256);
