CREATE TABLE "browser_session_screenshots" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"object_key" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_session_screenshots" ADD CONSTRAINT "browser_session_screenshots_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;