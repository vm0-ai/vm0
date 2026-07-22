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
