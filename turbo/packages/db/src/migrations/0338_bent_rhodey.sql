CREATE TABLE "telegram_official_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" varchar(255) NOT NULL,
	"telegram_username" varchar(255),
	"telegram_display_name" varchar(255),
	"vm0_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"dm_welcome_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_user_agent_preferences" (
	"vm0_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"selected_compose_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_user_agent_preferences_pkey" PRIMARY KEY("vm0_user_id","org_id")
);
--> statement-breakpoint
DROP INDEX "idx_telegram_messages_unique";--> statement-breakpoint
DROP INDEX "idx_telegram_messages_chat";--> statement-breakpoint
DROP INDEX "idx_telegram_thread_sessions_chat_user_link";--> statement-breakpoint
DROP INDEX "idx_telegram_thread_sessions_user_link";--> statement-breakpoint
ALTER TABLE "telegram_messages" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_thread_sessions" ALTER COLUMN "telegram_user_link_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "official_org_id" text;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD COLUMN "official_user_link_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_thread_sessions" ADD COLUMN "telegram_official_user_link_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_user_agent_preferences" ADD CONSTRAINT "telegram_user_agent_preferences_selected_compose_id_agent_composes_id_fk" FOREIGN KEY ("selected_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_official_user_links_tg_user" ON "telegram_official_user_links" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_official_user_links_vm0_org" ON "telegram_official_user_links" USING btree ("vm0_user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_telegram_official_user_links_org" ON "telegram_official_user_links" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_official_user_link_id_telegram_official_user_links_id_fk" FOREIGN KEY ("official_user_link_id") REFERENCES "public"."telegram_official_user_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_thread_sessions" ADD CONSTRAINT "telegram_thread_sessions_telegram_official_user_link_id_telegram_official_user_links_id_fk" FOREIGN KEY ("telegram_official_user_link_id") REFERENCES "public"."telegram_official_user_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_messages_official_unique" ON "telegram_messages" USING btree ("official_org_id","chat_id","message_id") WHERE official_org_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_telegram_messages_official_chat" ON "telegram_messages" USING btree ("official_org_id","chat_id") WHERE official_org_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_thread_sessions_chat_official_link" ON "telegram_thread_sessions" USING btree ("telegram_official_user_link_id","chat_id","root_message_id") WHERE telegram_official_user_link_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_telegram_thread_sessions_official_user_link" ON "telegram_thread_sessions" USING btree ("telegram_official_user_link_id") WHERE telegram_official_user_link_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_messages_unique" ON "telegram_messages" USING btree ("installation_id","chat_id","message_id") WHERE installation_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_telegram_messages_chat" ON "telegram_messages" USING btree ("installation_id","chat_id") WHERE installation_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_thread_sessions_chat_user_link" ON "telegram_thread_sessions" USING btree ("telegram_user_link_id","chat_id","root_message_id") WHERE telegram_user_link_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_telegram_thread_sessions_user_link" ON "telegram_thread_sessions" USING btree ("telegram_user_link_id") WHERE telegram_user_link_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "chk_telegram_messages_one_owner" CHECK ((installation_id IS NOT NULL) <> (official_org_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "telegram_thread_sessions" ADD CONSTRAINT "chk_telegram_thread_sessions_one_owner" CHECK ((telegram_user_link_id IS NOT NULL) <> (telegram_official_user_link_id IS NOT NULL));