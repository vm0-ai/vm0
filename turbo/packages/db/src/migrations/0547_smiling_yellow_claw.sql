ALTER TABLE "runner_state" ALTER COLUMN "profiles" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "runner_state" ADD COLUMN "admittable_profiles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "runner_state"
SET "admittable_profiles" = "available_profiles";
