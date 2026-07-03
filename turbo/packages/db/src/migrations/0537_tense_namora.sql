ALTER TABLE "runner_state" ADD COLUMN "available_profiles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "runner_state" SET "available_profiles" = "profiles";
