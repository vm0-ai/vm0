CREATE TYPE "public"."chat_thread_event_kind" AS ENUM('created', 'renamed', 'deleted', 'pinned', 'unpinned', 'sort_touched');--> statement-breakpoint
CREATE TABLE "chat_thread_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"kind" "chat_thread_event_kind" NOT NULL,
	"agent_compose_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_chat_thread_events_user_org_created" ON "chat_thread_events" USING btree ("user_id","org_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_chat_thread_events_thread_created" ON "chat_thread_events" USING btree ("chat_thread_id","created_at","id");