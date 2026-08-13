CREATE TABLE "chat_event_search_message_watermarks" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"indexed_seq_id" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_event_search_messages" (
	"chat_thread_id" uuid NOT NULL,
	"seq_id" bigint NOT NULL,
	"run_id" uuid,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"agent_compose_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"text" text NOT NULL,
	"text_bigram" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', text_bigram)) STORED,
	CONSTRAINT "chat_event_search_messages_chat_thread_id_seq_id_pk" PRIMARY KEY("chat_thread_id","seq_id")
);
--> statement-breakpoint
ALTER TABLE "chat_event_search_message_watermarks" ADD CONSTRAINT "chat_event_search_message_watermarks_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_event_search_messages" ADD CONSTRAINT "chat_event_search_messages_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_event_search_messages_user_org_created_idx" ON "chat_event_search_messages" USING btree ("user_id","org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_event_search_messages_user_org_agent_created_idx" ON "chat_event_search_messages" USING btree ("user_id","org_id","agent_compose_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_event_search_messages_tsv_idx" ON "chat_event_search_messages" USING gin ("tsv");