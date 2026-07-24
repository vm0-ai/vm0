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
INSERT INTO "compact_model_usage_observation" (
	"idempotency_key",
	"model",
	"input_tokens",
	"output_tokens",
	"cache_read_input_tokens",
	"cache_creation_input_tokens",
	"observed_at"
)
SELECT
	gen_random_uuid(),
	"model",
	COALESCE(SUM("quantity") FILTER (WHERE "category" = 'tokens.input'), 0)::bigint,
	COALESCE(SUM("quantity") FILTER (WHERE "category" = 'tokens.output'), 0)::bigint,
	COALESCE(SUM("quantity") FILTER (WHERE "category" = 'tokens.cache_read'), 0)::bigint,
	COALESCE(SUM("quantity") FILTER (WHERE "category" = 'tokens.cache_creation'), 0)::bigint,
	date_trunc('hour', "observed_at")::timestamp
FROM "model_usage_observation"
WHERE "observed_at" >= date_trunc('hour', NOW() AT TIME ZONE 'UTC') - INTERVAL '32 days'
	AND "category" IN (
		'tokens.input',
		'tokens.output',
		'tokens.cache_read',
		'tokens.cache_creation'
	)
	AND "quantity" > 0
GROUP BY "model", date_trunc('hour', "observed_at");
--> statement-breakpoint
CREATE INDEX "idx_compact_model_usage_observation_observed_at" ON "compact_model_usage_observation" USING btree ("observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_model_stat_hour_model" ON "model_stat" USING btree ("hour_start","model");
