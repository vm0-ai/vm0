-- Keep legacy API instances on the same cross-format identity boundary while
-- compact observation writers are adopted. Remove this trigger with the
-- compatibility ledger after the full retention and deployment gates in
-- #22760 and #22774.
CREATE FUNCTION "claim_model_usage_observation_legacy_key"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "model_usage_observation_legacy_key" (
		"idempotency_key",
		"observed_at"
	)
	VALUES (
		NEW."idempotency_key",
		NEW."observed_at"
	)
	ON CONFLICT ("idempotency_key") DO NOTHING;

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "claim_model_usage_observation_legacy_key"
BEFORE INSERT ON "model_usage_observation"
FOR EACH ROW EXECUTE FUNCTION "claim_model_usage_observation_legacy_key"();
