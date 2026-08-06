CREATE TABLE "pi_thread_messages" (
	"chat_thread_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"run_event_sequence_number" integer NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_thread_messages_chat_thread_id_version_ordinal_pk" PRIMARY KEY("chat_thread_id","version","ordinal")
);
--> statement-breakpoint
ALTER TABLE "pi_thread_messages" ADD CONSTRAINT "pi_thread_messages_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pi_thread_messages_message_id_unique" ON "pi_thread_messages" USING btree ("chat_thread_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pi_thread_messages_run_event_seq_unique" ON "pi_thread_messages" USING btree ("run_id","run_event_sequence_number");