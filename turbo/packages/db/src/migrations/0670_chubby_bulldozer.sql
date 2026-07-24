ALTER TYPE "public"."chat_message_queue_item_type" ADD VALUE 'feishu_user_message' BEFORE 'workflow_event';--> statement-breakpoint
CREATE TABLE "feishu_chat_ingress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"payload" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"reaction_id" varchar(255),
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_feishu_chat_ingress_status" CHECK ("feishu_chat_ingress"."status" IN ('pending', 'processing', 'processed', 'failed')),
	CONSTRAINT "chk_feishu_chat_ingress_retry_count" CHECK ("feishu_chat_ingress"."retry_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feishu_chat_thread_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"chat_id" varchar(255) NOT NULL,
	"thread_id" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "feishu_chat_open_url" text;--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD COLUMN "dm_welcome_sent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Connections created before welcome tracking already received the legacy welcome.
UPDATE "feishu_org_connections" SET "dm_welcome_sent" = true;--> statement-breakpoint
ALTER TABLE "feishu_chat_ingress" ADD CONSTRAINT "feishu_chat_ingress_installation_id_feishu_org_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."feishu_org_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_chat_thread_routes" ADD CONSTRAINT "feishu_chat_thread_routes_connection_id_feishu_org_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."feishu_org_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_chat_thread_routes" ADD CONSTRAINT "feishu_chat_thread_routes_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_chat_ingress_installation_event" ON "feishu_chat_ingress" USING btree ("installation_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_chat_thread_routes_conn_chat_thread_user" ON "feishu_chat_thread_routes" USING btree ("connection_id","chat_id","thread_id","user_id");
