ALTER TABLE "usage_event" DROP COLUMN "billing_sku";--> statement-breakpoint
DELETE FROM "usage_pricing"
WHERE "kind" = 'model'
  AND "provider" IN ('model-standard-v1', 'model-premium-v1');
