ALTER TABLE "org_plan_entitlements" ADD COLUMN "restricted_built_in_models" boolean;--> statement-breakpoint

-- Temporary #30162 expand/mirror bridge. Keep it through the later canonical
-- reader/writer switch, bounded backfill, and rollback drain owned by #28368.
-- PostgreSQL applies the restricted_vm0_models default before BEFORE INSERT,
-- so omission and an explicit default-valued legacy input are indistinguishable.
-- Deterministic insert policy: a non-NULL canonical input wins; otherwise the
-- defaulted or explicit legacy input wins.
CREATE FUNCTION public.sync_org_plan_entitlement_model_restrictions_1023()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  legacy_changed boolean;
  canonical_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."restricted_built_in_models" IS NULL THEN
      NEW."restricted_built_in_models" := NEW."restricted_vm0_models";
    ELSE
      NEW."restricted_vm0_models" := NEW."restricted_built_in_models";
    END IF;

    RETURN NEW;
  END IF;

  legacy_changed :=
    NEW."restricted_vm0_models" IS DISTINCT FROM
      OLD."restricted_vm0_models";
  canonical_changed :=
    NEW."restricted_built_in_models" IS DISTINCT FROM
      OLD."restricted_built_in_models";

  IF legacy_changed AND canonical_changed THEN
    IF NEW."restricted_vm0_models" IS NULL
      OR NEW."restricted_built_in_models" IS NULL
      OR NEW."restricted_vm0_models" IS DISTINCT FROM
        NEW."restricted_built_in_models"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'org plan entitlement model restrictions must match',
        CONSTRAINT = 'org_plan_entitlements_model_restriction_mirror_check';
    END IF;
  ELSIF legacy_changed THEN
    IF NEW."restricted_vm0_models" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'org plan entitlement model restrictions must match',
        CONSTRAINT = 'org_plan_entitlements_model_restriction_mirror_check';
    END IF;
    NEW."restricted_built_in_models" := NEW."restricted_vm0_models";
  ELSIF canonical_changed THEN
    IF NEW."restricted_built_in_models" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'org plan entitlement model restrictions must match',
        CONSTRAINT = 'org_plan_entitlements_model_restriction_mirror_check';
    END IF;
    NEW."restricted_vm0_models" := NEW."restricted_built_in_models";
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sync_org_plan_entitlement_model_restrictions_1023
BEFORE INSERT OR UPDATE OF
  "restricted_vm0_models", "restricted_built_in_models"
ON "org_plan_entitlements"
FOR EACH ROW
EXECUTE FUNCTION public.sync_org_plan_entitlement_model_restrictions_1023();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.ensure_legacy_org_metadata_plan_entitlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
		"restricted_built_in_models",
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
$$;
