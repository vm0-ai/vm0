ALTER TABLE "chat_feishu_context" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_chat_ingress" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD COLUMN "public_brand" text DEFAULT 'vm0' NOT NULL;