ALTER TABLE "slack_org_installations" ALTER COLUMN "public_brand" SET DEFAULT 'okou';--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;