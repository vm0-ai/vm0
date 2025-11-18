-- Drop api_keys table (no longer needed after migrating to bearer token auth)
DROP TABLE IF EXISTS "api_keys" CASCADE;
