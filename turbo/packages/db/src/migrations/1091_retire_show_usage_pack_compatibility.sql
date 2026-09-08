-- Deploy only after every serving and supported rollback API explicitly writes
-- show_usage_pack. The rollout gate is tracked in vm0-ai/vm0#32575.
DROP TRIGGER "trg_org_plan_entitlement_show_usage_pack" ON "org_plan_entitlements";
--> statement-breakpoint
DROP FUNCTION "sync_legacy_org_plan_entitlement_show_usage_pack"();
