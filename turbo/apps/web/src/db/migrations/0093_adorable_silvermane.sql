DROP TABLE "images" CASCADE;--> statement-breakpoint
DELETE FROM "scopes" WHERE "type" = 'system';--> statement-breakpoint
ALTER TABLE "scopes" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "scopes" ALTER COLUMN "type" SET DEFAULT 'personal'::text;--> statement-breakpoint
DROP TYPE "public"."scope_type";--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('personal', 'organization');--> statement-breakpoint
ALTER TABLE "scopes" ALTER COLUMN "type" SET DEFAULT 'personal'::"public"."scope_type";--> statement-breakpoint
ALTER TABLE "scopes" ALTER COLUMN "type" SET DATA TYPE "public"."scope_type" USING "type"::"public"."scope_type";