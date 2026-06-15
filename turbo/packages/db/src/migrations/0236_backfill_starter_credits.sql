-- Backfill starter credits for legacy free-tier orgs.
-- Migration 0180 changed the column DEFAULT from 0 to 10000 but did not
-- update existing rows, leaving old orgs with credits = 0.
UPDATE org_metadata
SET credits = credits + 10000,
    updated_at = now()
WHERE tier = 'free'
  AND credits = 0;
