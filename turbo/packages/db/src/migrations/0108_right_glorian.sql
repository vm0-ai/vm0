ALTER TABLE "scopes" ADD COLUMN "tier" varchar(16) DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "scopes" ADD CONSTRAINT "scopes_tier_check" CHECK ("scopes"."tier" IN ('free', 'pro'));