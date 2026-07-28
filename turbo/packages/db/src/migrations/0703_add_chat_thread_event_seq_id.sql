CREATE TABLE "chat_thread_event_sequences" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"last_seq_id" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "chat_thread_event_sequences_user_id_org_id_pk" PRIMARY KEY("user_id","org_id")
);
--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN "seq_id" bigint;--> statement-breakpoint
ALTER TABLE "chat_thread_snapshots" ADD COLUMN "latest_event_seq_id" bigint;