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
CREATE INDEX "idx_model_usage_observation_legacy_key_observed_at" ON "model_usage_observation_legacy_key" USING btree ("observed_at" DESC NULLS LAST);