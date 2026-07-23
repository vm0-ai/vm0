-- The trigger migration commits before this historical scan. It claims every
-- concurrent new legacy insert while this backfill covers rows accepted before
-- the trigger without retaining the trigger DDL lock for the scan.
INSERT INTO "model_usage_observation_legacy_key" (
	"idempotency_key",
	"observed_at"
)
SELECT
	"idempotency_key",
	"observed_at"
FROM "model_usage_observation"
ON CONFLICT ("idempotency_key") DO NOTHING;
