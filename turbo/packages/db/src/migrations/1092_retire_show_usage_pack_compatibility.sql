-- api-v1.570.0 and later explicitly write show_usage_pack; the production
-- rollback resolver enforces this floor. See docs/deployment-compatibility.md
-- and vm0-ai/vm0#32575 for the rollout evidence.
DROP TRIGGER "trg_org_plan_entitlement_show_usage_pack" ON "org_plan_entitlements";
--> statement-breakpoint
DROP FUNCTION "sync_legacy_org_plan_entitlement_show_usage_pack"();
