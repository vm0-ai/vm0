-- Migration: Increase storage name column length for system volumes
-- System volumes use naming convention: __system-prompt-{name}__ and __system-skill-{owner}/{repo}/{branch}/{path}__
-- These names can exceed 64 characters, so we increase to 256

ALTER TABLE "storages" ALTER COLUMN "name" TYPE varchar(256);
