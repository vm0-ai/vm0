ALTER TABLE "device_codes" ADD COLUMN "org_slug" text;--> statement-breakpoint
ALTER TABLE "org_members_cache" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_tokens" DROP COLUMN "org_id";