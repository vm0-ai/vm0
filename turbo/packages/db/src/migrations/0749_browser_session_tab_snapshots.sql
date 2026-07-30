CREATE TABLE "browser_session_tab_snapshots" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_tab_urls" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_session_tab_snapshots" ADD CONSTRAINT "browser_session_tab_snapshots_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;
