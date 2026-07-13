WITH "legacy_orgs" AS (
	SELECT
		"org_metadata".*,
		CASE
			WHEN "org_metadata"."tier" IN ('free', 'limited-free-1', 'pro-suspend', 'pro', 'team', 'custom')
				THEN "org_metadata"."tier"
			ELSE 'pro-suspend'
		END AS "normalized_tier",
		COUNT("org_metadata"."stripe_subscription_id") OVER (
			PARTITION BY "org_metadata"."stripe_subscription_id"
		) AS "stripe_subscription_ref_count"
	FROM "org_metadata"
),
"legacy_plan_entitlements" AS (
	SELECT
		"legacy_orgs"."org_id",
		"legacy_orgs"."normalized_tier" AS "plan_key",
		CASE "legacy_orgs"."normalized_tier"
			WHEN 'custom' THEN 3
			WHEN 'team' THEN 2
			WHEN 'pro' THEN 1
			ELSE 0
		END AS "plan_rank",
		'legacy_org_metadata_tier'::varchar(50) AS "source",
		CASE
			WHEN "legacy_orgs"."normalized_tier" = 'pro-suspend' THEN 'suspended'
			ELSE 'active'
		END::varchar(30) AS "status",
		CASE "legacy_orgs"."normalized_tier"
			WHEN 'free' THEN 1
			WHEN 'limited-free-1' THEN 1
			WHEN 'pro' THEN 2
			WHEN 'team' THEN 10
			WHEN 'custom' THEN 10
			ELSE 0
		END AS "base_concurrency_limit",
		"legacy_orgs"."normalized_tier" IN ('team', 'custom') AS "can_buy_concurrency",
		"legacy_orgs"."normalized_tier" IN ('pro', 'team', 'custom') AS "auto_recharge_allowed",
		"legacy_orgs"."normalized_tier" IN ('free', 'pro', 'team', 'custom') AS "support_byok",
		"legacy_orgs"."normalized_tier" IN ('limited-free-1', 'pro-suspend') AS "restricted_vm0_models",
		"legacy_orgs"."normalized_tier" IN ('free', 'pro', 'team', 'custom') AS "video_generation_allowed",
		CASE
			WHEN "legacy_orgs"."normalized_tier" IN ('pro', 'team', 'custom') THEN NULL
			WHEN "legacy_orgs"."normalized_tier" = 'pro-suspend' THEN 0
			ELSE 10
		END AS "audio_lifetime_limit",
		CASE "legacy_orgs"."normalized_tier"
			WHEN 'free' THEN 10
			WHEN 'limited-free-1' THEN 10
			WHEN 'pro' THEN 300
			WHEN 'team' THEN 500
			WHEN 'custom' THEN 500
			ELSE 0
		END AS "audio_daily_rate_limit",
		CASE "legacy_orgs"."normalized_tier"
			WHEN 'free' THEN 600
			WHEN 'limited-free-1' THEN 600
			WHEN 'pro' THEN 12000
			WHEN 'team' THEN 30000
			WHEN 'custom' THEN 30000
			ELSE 0
		END AS "audio_daily_duration_seconds",
		CASE
			WHEN "legacy_orgs"."normalized_tier" IN ('pro', 'team')
				AND "legacy_orgs"."stripe_subscription_id" IS NOT NULL
				AND "legacy_orgs"."stripe_subscription_ref_count" = 1
				AND NOT EXISTS (
					SELECT 1
					FROM "org_plan_entitlements" "existing_plan_entitlements"
					WHERE "existing_plan_entitlements"."stripe_subscription_id" = "legacy_orgs"."stripe_subscription_id"
						AND "existing_plan_entitlements"."org_id" <> "legacy_orgs"."org_id"
				)
				THEN "legacy_orgs"."stripe_subscription_id"
			ELSE NULL
		END AS "stripe_subscription_id",
		NULL::text AS "stripe_product_id",
		NULL::text AS "stripe_price_id",
		NULL::timestamp AS "current_period_start",
		"legacy_orgs"."current_period_end",
		CASE
			WHEN "legacy_orgs"."cancel_at_period_end" THEN "legacy_orgs"."current_period_end"
			ELSE NULL
		END AS "cancel_at",
		CASE
			WHEN "legacy_orgs"."cancel_at_period_end" THEN "legacy_orgs"."current_period_end"
			ELSE NULL
		END AS "expires_at",
		'1' AS "metadata_version",
		NULL::text AS "metadata_hash",
		jsonb_strip_nulls(
			jsonb_build_object(
				'legacyTier', "legacy_orgs"."tier",
				'normalizedTier', CASE
					WHEN "legacy_orgs"."tier" <> "legacy_orgs"."normalized_tier" THEN "legacy_orgs"."normalized_tier"
					ELSE NULL
				END,
				'sourceTable', 'org_metadata',
				'migration', '0566_backfill_org_plan_entitlements',
				'stripeCustomerId', "legacy_orgs"."stripe_customer_id",
				'stripeSubscriptionId', "legacy_orgs"."stripe_subscription_id",
				'subscriptionStatus', "legacy_orgs"."subscription_status",
				'cancelAtPeriodEnd', CASE
					WHEN "legacy_orgs"."cancel_at_period_end" THEN 'true'
					ELSE NULL
				END,
				'stripeSubscriptionBackfillSkipped', CASE
					WHEN "legacy_orgs"."normalized_tier" IN ('pro', 'team')
						AND "legacy_orgs"."stripe_subscription_id" IS NOT NULL
						AND "legacy_orgs"."stripe_subscription_ref_count" > 1
						THEN 'duplicate_legacy_subscription'
					WHEN "legacy_orgs"."normalized_tier" IN ('pro', 'team')
						AND "legacy_orgs"."stripe_subscription_id" IS NOT NULL
						AND EXISTS (
							SELECT 1
							FROM "org_plan_entitlements" "existing_plan_entitlements"
							WHERE "existing_plan_entitlements"."stripe_subscription_id" = "legacy_orgs"."stripe_subscription_id"
								AND "existing_plan_entitlements"."org_id" <> "legacy_orgs"."org_id"
						)
						THEN 'conflicting_plan_entitlement_subscription'
					ELSE NULL
				END
			)
		) AS "source_metadata"
	FROM "legacy_orgs"
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
	"stripe_product_id",
	"stripe_price_id",
	"current_period_start",
	"current_period_end",
	"cancel_at",
	"expires_at",
	"metadata_version",
	"metadata_hash",
	"source_metadata"
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
	"stripe_product_id",
	"stripe_price_id",
	"current_period_start",
	"current_period_end",
	"cancel_at",
	"expires_at",
	"metadata_version",
	"metadata_hash",
	"source_metadata"
FROM "legacy_plan_entitlements"
ON CONFLICT ("org_id") DO UPDATE SET
	"plan_key" = EXCLUDED."plan_key",
	"plan_rank" = EXCLUDED."plan_rank",
	"source" = EXCLUDED."source",
	"status" = EXCLUDED."status",
	"base_concurrency_limit" = EXCLUDED."base_concurrency_limit",
	"can_buy_concurrency" = EXCLUDED."can_buy_concurrency",
	"auto_recharge_allowed" = EXCLUDED."auto_recharge_allowed",
	"support_byok" = EXCLUDED."support_byok",
	"restricted_vm0_models" = EXCLUDED."restricted_vm0_models",
	"video_generation_allowed" = EXCLUDED."video_generation_allowed",
	"audio_lifetime_limit" = EXCLUDED."audio_lifetime_limit",
	"audio_daily_rate_limit" = EXCLUDED."audio_daily_rate_limit",
	"audio_daily_duration_seconds" = EXCLUDED."audio_daily_duration_seconds",
	"stripe_subscription_id" = EXCLUDED."stripe_subscription_id",
	"stripe_product_id" = EXCLUDED."stripe_product_id",
	"stripe_price_id" = EXCLUDED."stripe_price_id",
	"current_period_start" = EXCLUDED."current_period_start",
	"current_period_end" = EXCLUDED."current_period_end",
	"cancel_at" = EXCLUDED."cancel_at",
	"expires_at" = EXCLUDED."expires_at",
	"metadata_version" = EXCLUDED."metadata_version",
	"metadata_hash" = EXCLUDED."metadata_hash",
	"source_metadata" = EXCLUDED."source_metadata",
	"updated_at" = now();
