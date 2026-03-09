ALTER TABLE "scopes" DROP CONSTRAINT "scopes_tier_check";--> statement-breakpoint
ALTER TABLE "scopes" ADD CONSTRAINT "scopes_tier_check" CHECK ("scopes"."tier" IN ('free', 'pro', 'max'));
