ALTER TABLE "org_plan_entitlements" ADD COLUMN "workflow_webhook_trigger_allowed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "org_plan_entitlements"
SET "workflow_webhook_trigger_allowed" = true
WHERE "plan_key" IN ('team', 'custom');
