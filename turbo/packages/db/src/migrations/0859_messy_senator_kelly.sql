CREATE TABLE "chat_event_search_docs" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"text" text NOT NULL,
	"text_bigram" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_event_search_watermarks" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"indexed_seq_id" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_event_search_docs" ADD CONSTRAINT "chat_event_search_docs_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_event_search_watermarks" ADD CONSTRAINT "chat_event_search_watermarks_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_event_search_docs_user_org_created_idx" ON "chat_event_search_docs" USING btree ("user_id","org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_event_search_docs_thread_idx" ON "chat_event_search_docs" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "chat_event_search_docs_tsv_idx" ON "chat_event_search_docs" USING gin (to_tsvector('simple', "text_bigram"));