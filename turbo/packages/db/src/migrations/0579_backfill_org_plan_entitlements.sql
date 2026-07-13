-- Custom SQL migration file, put your code below! --
WITH "legacy_org_metadata" AS (
	SELECT
		"org_metadata".*,
		CASE
			WHEN "tier" IN (
				'free',
				'limited-free-1',
				'pro-suspend',
				'pro',
				'team',
				'custom'
			)
				THEN "tier"
			ELSE 'pro-suspend'
		END AS "normalized_tier",
		count(*) OVER (PARTITION BY "stripe_subscription_id") AS "stripe_subscription_row_count"
	FROM "org_metadata"
),
"backfill_rows" AS (
	SELECT
		"org_id",
		"normalized_tier" AS "plan_key",
		CASE "normalized_tier"
			WHEN 'pro' THEN 1
			WHEN 'team' THEN 2
			WHEN 'custom' THEN 3
			ELSE 0
		END AS "plan_rank",
		CASE
			WHEN "subscription_status" = 'atom_grant' THEN 'stripe_atom_grant'
			WHEN "stripe_subscription_id" IS NOT NULL THEN 'stripe_subscription'
			ELSE 'org_metadata_migration'
		END AS "source",
		CASE WHEN "normalized_tier" = 'pro-suspend' THEN 'suspended' ELSE 'active' END AS "status",
		CASE "normalized_tier"
			WHEN 'free' THEN 1
			WHEN 'limited-free-1' THEN 1
			WHEN 'pro' THEN 2
			WHEN 'team' THEN 10
			WHEN 'custom' THEN 10
			ELSE 0
		END AS "base_concurrency_limit",
		"normalized_tier" IN ('team', 'custom') AS "can_buy_concurrency",
		"normalized_tier" IN ('pro', 'team', 'custom') AS "auto_recharge_allowed",
		"normalized_tier" IN ('free', 'pro', 'team', 'custom') AS "support_byok",
		"normalized_tier" NOT IN ('free', 'pro', 'team', 'custom') AS "restricted_vm0_models",
		"normalized_tier" IN ('free', 'pro', 'team', 'custom') AS "video_generation_allowed",
		CASE
			WHEN "normalized_tier" IN ('pro', 'team', 'custom') THEN NULL
			WHEN "normalized_tier" IN ('free', 'limited-free-1') THEN 10
			ELSE 0
		END AS "audio_lifetime_limit",
		CASE "normalized_tier"
			WHEN 'free' THEN 10
			WHEN 'limited-free-1' THEN 10
			WHEN 'pro' THEN 300
			WHEN 'team' THEN 500
			WHEN 'custom' THEN 500
			ELSE 0
		END AS "audio_daily_rate_limit",
		CASE "normalized_tier"
			WHEN 'free' THEN 600
			WHEN 'limited-free-1' THEN 600
			WHEN 'pro' THEN 12000
			WHEN 'team' THEN 30000
			WHEN 'custom' THEN 30000
			ELSE 0
		END AS "audio_daily_duration_seconds",
		CASE
			WHEN "stripe_subscription_id" IS NOT NULL
				AND "stripe_subscription_row_count" = 1
				THEN "stripe_subscription_id"
			ELSE NULL
		END AS "stripe_subscription_id",
		"current_period_end",
		CASE WHEN "cancel_at_period_end" THEN "current_period_end" ELSE NULL END AS "cancel_at",
		CASE
			WHEN "subscription_status" = 'atom_grant' OR "cancel_at_period_end"
				THEN "current_period_end"
			ELSE NULL
		END AS "expires_at",
		jsonb_strip_nulls(
			jsonb_build_object(
				'legacyTier',
				CASE WHEN "tier" <> "normalized_tier" THEN "tier" ELSE NULL END,
				'stripeSubscriptionBackfillSkipped',
				CASE
					WHEN "stripe_subscription_id" IS NOT NULL
						AND "stripe_subscription_row_count" > 1
						THEN 'duplicate_stripe_subscription_id'
					ELSE NULL
				END
			)
		) AS "source_metadata",
		"created_at",
		now() AS "updated_at"
	FROM "legacy_org_metadata"
)
INSERT INTO "org_plan_entitlements" (
	"org_id",
	"plan_key",
	"plan_rank",
	"source",
	"status",
	"base_concurrency_limit",
	"can_buy_concurrency",
	"auto_recharge_allowed",
	"support_byok",
	"restricted_vm0_models",
	"video_generation_allowed",
	"audio_lifetime_limit",
	"audio_daily_rate_limit",
	"audio_daily_duration_seconds",
	"stripe_subscription_id",
	"current_period_end",
	"cancel_at",
	"expires_at",
	"source_metadata",
	"created_at",
	"updated_at"
)
SELECT
	"org_id",
	"plan_key",
	"plan_rank",
	"source",
	"status",
	"base_concurrency_limit",
	"can_buy_concurrency",
	"auto_recharge_allowed",
	"support_byok",
	"restricted_vm0_models",
	"video_generation_allowed",
	"audio_lifetime_limit",
	"audio_daily_rate_limit",
	"audio_daily_duration_seconds",
	"stripe_subscription_id",
	"current_period_end",
	"cancel_at",
	"expires_at",
	"source_metadata",
	"created_at",
	"updated_at"
FROM "backfill_rows"
ON CONFLICT ("org_id") DO UPDATE SET
	"plan_key" = excluded."plan_key",
	"plan_rank" = excluded."plan_rank",
	"source" = excluded."source",
	"status" = excluded."status",
	"base_concurrency_limit" = excluded."base_concurrency_limit",
	"can_buy_concurrency" = excluded."can_buy_concurrency",
	"auto_recharge_allowed" = excluded."auto_recharge_allowed",
	"support_byok" = excluded."support_byok",
	"restricted_vm0_models" = excluded."restricted_vm0_models",
	"video_generation_allowed" = excluded."video_generation_allowed",
	"audio_lifetime_limit" = excluded."audio_lifetime_limit",
	"audio_daily_rate_limit" = excluded."audio_daily_rate_limit",
	"audio_daily_duration_seconds" = excluded."audio_daily_duration_seconds",
	"stripe_subscription_id" = excluded."stripe_subscription_id",
	"current_period_end" = excluded."current_period_end",
	"cancel_at" = excluded."cancel_at",
	"expires_at" = excluded."expires_at",
	"source_metadata" = excluded."source_metadata",
	"updated_at" = excluded."updated_at";
