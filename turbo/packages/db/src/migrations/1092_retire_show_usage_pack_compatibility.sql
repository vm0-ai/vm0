-- The production API explicitly writes show_usage_pack. The existing Okou Goal
-- rollback floor (API 1.571.1) also includes that writer. See the rollout
-- evidence in docs/deployment-compatibility.md and vm0-ai/vm0#32575.
DROP TRIGGER "trg_org_plan_entitlement_show_usage_pack" ON "org_plan_entitlements";
--> statement-breakpoint
DROP FUNCTION "sync_legacy_org_plan_entitlement_show_usage_pack"();
