CREATE TABLE "telegram_chat_thread_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_link_id" uuid,
	"telegram_official_user_link_id" uuid,
	"chat_id" varchar(255) NOT NULL,
	"root_message_id" varchar(255) NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_telegram_chat_thread_routes_one_owner" CHECK ((telegram_user_link_id IS NOT NULL) <> (telegram_official_user_link_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "telegram_chat_thread_routes" ADD CONSTRAINT "telegram_chat_thread_routes_telegram_user_link_id_telegram_user_links_id_fk" FOREIGN KEY ("telegram_user_link_id") REFERENCES "public"."telegram_user_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_thread_routes" ADD CONSTRAINT "telegram_chat_thread_routes_telegram_official_user_link_id_telegram_official_user_links_id_fk" FOREIGN KEY ("telegram_official_user_link_id") REFERENCES "public"."telegram_official_user_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chat_thread_routes" ADD CONSTRAINT "telegram_chat_thread_routes_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_chat_thread_routes_chat_user_link" ON "telegram_chat_thread_routes" USING btree ("telegram_user_link_id","chat_id","root_message_id") WHERE telegram_user_link_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telegram_chat_thread_routes_chat_official_link" ON "telegram_chat_thread_routes" USING btree ("telegram_official_user_link_id","chat_id","root_message_id") WHERE telegram_official_user_link_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_telegram_chat_thread_routes_user_link" ON "telegram_chat_thread_routes" USING btree ("telegram_user_link_id") WHERE telegram_user_link_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_telegram_chat_thread_routes_official_user_link" ON "telegram_chat_thread_routes" USING btree ("telegram_official_user_link_id") WHERE telegram_official_user_link_id IS NOT NULL;