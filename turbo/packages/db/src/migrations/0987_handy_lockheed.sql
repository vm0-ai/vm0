ALTER TABLE "chat_feishu_context" ADD COLUMN "public_brand" text;--> statement-breakpoint
ALTER TABLE "feishu_chat_ingress" ADD COLUMN "public_brand" text;--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD COLUMN "public_brand" text;