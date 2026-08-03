CREATE TABLE "browser_session_screenshots" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"object_key" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
