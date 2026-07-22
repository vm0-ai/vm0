ALTER TABLE "org_plan_entitlements" ADD COLUMN "can_buy_credits" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "org_plan_entitlements"
SET "can_buy_credits" = true
WHERE "plan_key" IN ('free', 'pro', 'team', 'custom');
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements" ADD COLUMN IF NOT EXISTS "workflow_webhook_trigger_allowed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "org_plan_entitlements"
SET "workflow_webhook_trigger_allowed" = true
WHERE "plan_key" IN ('team', 'custom');
--> statement-breakpoint
-- Keep pre-0639 API instances safe while they are still serving during the
-- rollout. Those writers update plan_key but do not know about can_buy_credits.
-- Remove this compatibility trigger after every serving API version includes
-- can_buy_credits in its entitlement writes.
CREATE FUNCTION "sync_legacy_org_plan_entitlement_can_buy_credits"() RETURNS trigger AS $$
BEGIN
	IF NEW."source" IN (
		'stripe_subscription',
		'stripe_atom_grant',
		'org_metadata_bootstrap',
		'org_metadata_migration'
	) THEN
		NEW."can_buy_credits" := NEW."plan_key" IN ('free', 'pro', 'team', 'custom');
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "sync_legacy_org_plan_entitlement_can_buy_credits"
BEFORE INSERT OR UPDATE OF "plan_key" ON "org_plan_entitlements"
FOR EACH ROW EXECUTE FUNCTION "sync_legacy_org_plan_entitlement_can_buy_credits"();
--> statement-breakpoint
-- Some pre-0639 writers only create org_metadata because plan entitlements
-- were not required by those code paths. Materialize the tier snapshot at the
-- database boundary so an org created during the rolling deployment never
-- reaches the new API without an entitlement row. A current writer can safely
-- replace this compatibility snapshot later in the same transaction.
CREATE FUNCTION "ensure_legacy_org_metadata_plan_entitlement"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "org_plan_entitlements" (
		"org_id",
		"plan_key",
		"plan_rank",
		"source",
		"status",
		"base_concurrency_limit",
		"can_buy_concurrency",
		"can_buy_credits",
		"auto_recharge_allowed",
		"support_byok",
		"restricted_vm0_models",
		"video_generation_allowed",
		"workflow_webhook_trigger_allowed",
		"audio_lifetime_limit",
		"audio_daily_rate_limit",
		"audio_daily_duration_seconds"
	)
	SELECT
		NEW."org_id",
		plans."plan_key",
		plans."plan_rank",
		'org_metadata_migration',
		plans."status",
		plans."base_concurrency_limit",
		plans."can_buy_concurrency",
		plans."can_buy_credits",
		plans."auto_recharge_allowed",
		plans."support_byok",
		plans."restricted_vm0_models",
		plans."video_generation_allowed",
		plans."workflow_webhook_trigger_allowed",
		plans."audio_lifetime_limit",
		plans."audio_daily_rate_limit",
		plans."audio_daily_duration_seconds"
	FROM (
		VALUES
			('free', 0, 'active', 1, false, true, false, true, false, true, false, 10, 10, 600),
			('limited-free-1', 0, 'active', 1, false, false, false, false, true, false, false, 10, 10, 600),
			('pro-suspend', 0, 'suspended', 0, false, false, false, false, true, false, false, 0, 0, 0),
			('pro', 1, 'active', 2, false, true, true, true, false, true, false, NULL, 300, 12000),
			('team', 2, 'active', 10, true, true, true, true, false, true, true, NULL, 500, 30000),
			('custom', 3, 'active', 10, true, true, true, true, false, true, true, NULL, 500, 30000)
	) AS plans(
		"plan_key",
		"plan_rank",
		"status",
		"base_concurrency_limit",
		"can_buy_concurrency",
		"can_buy_credits",
		"auto_recharge_allowed",
		"support_byok",
		"restricted_vm0_models",
		"video_generation_allowed",
		"workflow_webhook_trigger_allowed",
		"audio_lifetime_limit",
		"audio_daily_rate_limit",
		"audio_daily_duration_seconds"
	)
	WHERE plans."plan_key" = NEW."tier"
	ON CONFLICT ("org_id") DO NOTHING;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "ensure_legacy_org_metadata_plan_entitlement"
AFTER INSERT ON "org_metadata"
FOR EACH ROW EXECUTE FUNCTION "ensure_legacy_org_metadata_plan_entitlement"();
