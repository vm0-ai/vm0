CREATE TABLE "agentphone_chat_thread_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agentphone_user_link_id" uuid NOT NULL,
	"root_message_id" varchar(255) NOT NULL,
	"conversation_id" varchar(255),
	"chat_thread_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD CONSTRAINT "agentphone_chat_thread_routes_agentphone_user_link_id_agentphone_user_links_id_fk" FOREIGN KEY ("agentphone_user_link_id") REFERENCES "public"."agentphone_user_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD CONSTRAINT "agentphone_chat_thread_routes_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agentphone_chat_thread_routes_link_root" ON "agentphone_chat_thread_routes" USING btree ("agentphone_user_link_id","root_message_id");--> statement-breakpoint
CREATE INDEX "idx_agentphone_chat_thread_routes_user_link" ON "agentphone_chat_thread_routes" USING btree ("agentphone_user_link_id");--> statement-breakpoint
CREATE INDEX "idx_agentphone_chat_thread_routes_conversation" ON "agentphone_chat_thread_routes" USING btree ("conversation_id");
