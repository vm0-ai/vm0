-- BB0 rows and credentials must remain until old API instances and the
-- rollback window have drained; deleting them before promotion races old writers.
UPDATE "user_feature_switches"
SET
  "switches" = "switches" - 'apiKeys',
  "updated_at" = NOW()
WHERE "switches" ? 'apiKeys';
