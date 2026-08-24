ALTER TABLE "teams_org_installations" ALTER COLUMN "public_brand" SET DEFAULT 'okou';--> statement-breakpoint
ALTER TABLE "chat_teams_context" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;