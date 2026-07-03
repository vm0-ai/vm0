ALTER TABLE "org_metadata" ADD COLUMN "onboarding_complete" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "org_metadata" SET "onboarding_complete" = true;
