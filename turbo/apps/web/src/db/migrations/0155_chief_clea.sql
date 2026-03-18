ALTER TABLE "org_members_cache" ADD COLUMN IF NOT EXISTS "onboarding_done" boolean DEFAULT false NOT NULL;
