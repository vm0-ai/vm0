-- Update default starter credits from 10000 to 100000 for new orgs.
ALTER TABLE org_metadata ALTER COLUMN credits SET DEFAULT 100000;
