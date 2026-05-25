ALTER TABLE "org" ADD COLUMN "tier" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "default_agent_compose_id" uuid;--> statement-breakpoint
UPDATE "org" SET "tier" = "org_cache"."tier"
FROM "org_cache" WHERE "org"."org_id" = "org_cache"."org_id";--> statement-breakpoint
INSERT INTO "org" ("org_id", "tier")
SELECT "org_id", "tier" FROM "org_cache"
WHERE "org_id" NOT IN (SELECT "org_id" FROM "org")
ON CONFLICT ("org_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "org_cache" DROP COLUMN "tier";