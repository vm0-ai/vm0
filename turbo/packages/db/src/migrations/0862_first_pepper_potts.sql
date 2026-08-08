CREATE TABLE "chat_event_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"parent_snapshot_id" uuid,
	"last_seq_id" bigint NOT NULL,
	"archive_schema_version" integer NOT NULL,
	"object_key" text NOT NULL,
	"is_head" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_event_snapshots_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD CONSTRAINT "chat_event_snapshots_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD CONSTRAINT "chat_event_snapshots_parent_snapshot_id_chat_event_snapshots_id_fk" FOREIGN KEY ("parent_snapshot_id") REFERENCES "public"."chat_event_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_snapshots_thread_head_unique" ON "chat_event_snapshots" USING btree ("chat_thread_id") WHERE "chat_event_snapshots"."is_head";--> statement-breakpoint
CREATE INDEX "chat_event_snapshots_thread_idx" ON "chat_event_snapshots" USING btree ("chat_thread_id");