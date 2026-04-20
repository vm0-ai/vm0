ALTER TABLE "device_codes" DROP COLUMN IF EXISTS "org_slug";--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN IF NOT EXISTS "org_id" text;
