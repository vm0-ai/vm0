-- "automation" superseded "schedule" as the trigger source (#17307). Writers
-- flipped in #17334 and every reader accepts both values, so this backfill
-- unifies the historical rows. Idempotent; ships standalone after the reader
-- code is live in production (per the #17280 incident learning).
UPDATE "zero_runs"
SET "trigger_source" = 'automation'
WHERE "trigger_source" = 'schedule';
