CREATE TABLE "slack_chat_ingress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"payload" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_slack_chat_ingress_status" CHECK ("slack_chat_ingress"."status" IN ('pending', 'processing', 'processed', 'failed')),
	CONSTRAINT "chk_slack_chat_ingress_retry_count" CHECK ("slack_chat_ingress"."retry_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD CONSTRAINT "slack_chat_ingress_route_id_slack_chat_thread_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."slack_chat_thread_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_chat_ingress_event_id" ON "slack_chat_ingress" USING btree ("event_id");