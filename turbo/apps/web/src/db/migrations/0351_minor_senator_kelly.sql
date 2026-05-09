DROP INDEX "idx_org_model_policies_enabled";--> statement-breakpoint
DELETE FROM "org_model_policies" WHERE "enabled" = false AND "is_default" = false;--> statement-breakpoint
ALTER TABLE "org_model_policies" DROP COLUMN "enabled";
