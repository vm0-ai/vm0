CREATE TABLE "slack_chat_thread_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"thread_ts" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"backend" varchar(16) NOT NULL,
	"chat_thread_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_slack_chat_thread_routes_backend_thread" CHECK (("slack_chat_thread_routes"."backend" = 'legacy' AND "slack_chat_thread_routes"."chat_thread_id" IS NULL)
          OR ("slack_chat_thread_routes"."backend" = 'canonical' AND "slack_chat_thread_routes"."chat_thread_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "slack_chat_thread_routes" ADD CONSTRAINT "slack_chat_thread_routes_connection_id_slack_org_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."slack_org_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_chat_thread_routes" ADD CONSTRAINT "slack_chat_thread_routes_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_chat_thread_routes_conn_channel_thread_user" ON "slack_chat_thread_routes" USING btree ("connection_id","channel_id","thread_ts","user_id");