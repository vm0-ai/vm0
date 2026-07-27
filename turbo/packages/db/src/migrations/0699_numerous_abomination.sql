ALTER TYPE "public"."chat_message_queue_item_type" ADD VALUE 'teams_user_message' BEFORE 'workflow_event';--> statement-breakpoint
CREATE TABLE "teams_chat_thread_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"conversation_id" varchar(255) NOT NULL,
	"thread_id" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams_chat_thread_routes" ADD CONSTRAINT "teams_chat_thread_routes_connection_id_teams_org_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."teams_org_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_chat_thread_routes" ADD CONSTRAINT "teams_chat_thread_routes_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_chat_thread_routes_conn_conversation_thread_user" ON "teams_chat_thread_routes" USING btree ("connection_id","conversation_id","thread_id","user_id");