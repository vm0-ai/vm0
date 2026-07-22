ALTER TABLE "org_plan_entitlements" ADD COLUMN "can_buy_credits" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "org_plan_entitlements"
SET "can_buy_credits" = true
WHERE "plan_key" IN ('free', 'pro', 'team', 'custom');
