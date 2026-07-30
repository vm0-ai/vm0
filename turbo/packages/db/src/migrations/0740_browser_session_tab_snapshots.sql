CREATE TABLE "browser_session_tab_snapshots" (
	"browser_session_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_tab_urls" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_session_tab_snapshots" ADD CONSTRAINT "browser_session_tab_snapshots_browser_session_id_browser_sessions_id_fk" FOREIGN KEY ("browser_session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;