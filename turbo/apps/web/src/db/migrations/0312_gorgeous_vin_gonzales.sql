ALTER TABLE "telegram_messages" DROP CONSTRAINT "telegram_messages_installation_id_telegram_installations_telegr";
--> statement-breakpoint
ALTER TABLE "telegram_user_links" DROP CONSTRAINT "telegram_user_links_installation_id_telegram_installations_tele";
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "last_read_message_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_installation_id_telegram_installations_telegram_bot_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."telegram_installations"("telegram_bot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_user_links" ADD CONSTRAINT "telegram_user_links_installation_id_telegram_installations_telegram_bot_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."telegram_installations"("telegram_bot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_threads_user_last_read_message" ON "chat_threads" USING btree ("user_id","last_read_message_id");