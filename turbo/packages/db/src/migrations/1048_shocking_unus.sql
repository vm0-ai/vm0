CREATE TABLE "chat_event_snapshot_scan_state" (
	"scope" text PRIMARY KEY NOT NULL,
	"cursor_chat_thread_id" uuid,
	"cycle_upper_bound_last_message_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "chat_event_snapshot_scan_state_scope_check" CHECK ("chat_event_snapshot_scan_state"."scope" = 'global')
);
--> statement-breakpoint
INSERT INTO "chat_event_snapshot_scan_state" ("scope") VALUES ('global');
