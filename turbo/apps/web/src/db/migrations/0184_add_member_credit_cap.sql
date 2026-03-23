ALTER TABLE "org_members_metadata" ADD COLUMN "credit_cap" bigint;--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD COLUMN "credit_enabled" boolean DEFAULT true NOT NULL;