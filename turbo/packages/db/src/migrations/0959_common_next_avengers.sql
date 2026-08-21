ALTER TABLE "browser_sessions" ALTER COLUMN "public_brand" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "hosted_deployments" ALTER COLUMN "public_brand" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "hosted_sites" ALTER COLUMN "public_brand" DROP DEFAULT;