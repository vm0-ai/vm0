CREATE TABLE "compact_model_usage_observation" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"model" varchar(255) NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_input_tokens" bigint NOT NULL,
	"cache_creation_input_tokens" bigint NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_usage_observation_legacy_key" (
	"idempotency_key" uuid PRIMARY KEY NOT NULL,
	"observed_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_compact_model_usage_observation_observed_at" ON "compact_model_usage_observation" USING btree ("observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_model_usage_observation_legacy_key_observed_at" ON "model_usage_observation_legacy_key" USING btree ("observed_at" DESC NULLS LAST);--> statement-breakpoint
-- Keep legacy API instances on the same cross-format identity boundary while
-- compact observation writers are adopted. Historical keys remain queryable
-- through the legacy table's existing unique index, so no backfill is needed.
-- Remove this trigger with the compatibility ledger after the rollout and
-- old-writer drain gates in #22760 and #22774.
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
