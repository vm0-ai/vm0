CREATE TABLE "model_usage_observation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"model" varchar(255) NOT NULL,
	"model_provider_type" varchar(100) DEFAULT '' NOT NULL,
	"category" varchar(100) NOT NULL,
	"quantity" bigint NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_usage_observation" ADD CONSTRAINT "model_usage_observation_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_model_usage_observation_idempotency_key" ON "model_usage_observation" USING btree ("idempotency_key");--> statement-breakpoint
INSERT INTO "model_usage_observation" (
	"run_id",
	"idempotency_key",
	"org_id",
	"user_id",
	"model",
	"model_provider_type",
	"category",
	"quantity",
	"observed_at",
	"created_at"
)
SELECT
	"run_id",
	"idempotency_key",
	"org_id",
	"user_id",
	CASE "provider"
		WHEN 'anthropic/claude-opus-4.8' THEN 'claude-opus-4-8'
		WHEN 'anthropic/claude-opus-4.7' THEN 'claude-opus-4-7'
		WHEN 'anthropic/claude-opus-4.6' THEN 'claude-opus-4-6'
		WHEN 'anthropic/claude-sonnet-4.6' THEN 'claude-sonnet-4-6'
		WHEN 'z-ai/glm-5.1' THEN 'glm-5.1'
		WHEN 'deepseek/deepseek-v4-pro' THEN 'deepseek-v4-pro'
		WHEN 'moonshotai/kimi-k2.6' THEN 'kimi-k2.6'
		WHEN 'moonshotai/kimi-k2.5' THEN 'kimi-k2.5'
		ELSE "provider"
	END AS "model",
	'vm0' AS "model_provider_type",
	"category",
	"quantity",
	"created_at" AS "observed_at",
	NOW() AS "created_at"
FROM "usage_event"
WHERE "kind" = 'model'
	AND "created_at" >= NOW() - INTERVAL '32 days'
	AND "category" IN (
		'tokens.input',
		'tokens.output',
		'tokens.cache_read',
		'tokens.cache_creation'
	)
	AND "quantity" > 0
	AND "provider" IN (
		'claude-opus-4-8',
		'claude-opus-4-7',
		'claude-opus-4-6',
		'claude-sonnet-4-6',
		'deepseek-v4-pro',
		'kimi-k2.6',
		'kimi-k2.5',
		'MiniMax-M3',
		'glm-5.1',
		'gpt-5.5',
		'gpt-5.4',
		'gpt-5.4-mini',
		'anthropic/claude-opus-4.8',
		'anthropic/claude-opus-4.7',
		'anthropic/claude-opus-4.6',
		'anthropic/claude-sonnet-4.6',
		'z-ai/glm-5.1',
		'deepseek/deepseek-v4-pro',
		'moonshotai/kimi-k2.6',
		'moonshotai/kimi-k2.5'
	)
ON CONFLICT ("idempotency_key") DO NOTHING;--> statement-breakpoint
CREATE INDEX "idx_model_usage_observation_run_id" ON "model_usage_observation" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_model_usage_observation_observed_at" ON "model_usage_observation" USING btree ("observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_model_usage_observation_model_observed_at" ON "model_usage_observation" USING btree ("model","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_model_usage_observation_org_observed_at" ON "model_usage_observation" USING btree ("org_id","observed_at" DESC NULLS LAST);
