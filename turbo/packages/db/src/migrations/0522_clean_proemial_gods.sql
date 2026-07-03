CREATE TABLE "html_artifact_edit_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"artifact_url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "html_artifact_edit_drafts" ADD CONSTRAINT "html_artifact_edit_drafts_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_html_artifact_edit_drafts_thread_artifact" ON "html_artifact_edit_drafts" USING btree ("chat_thread_id","artifact_url");--> statement-breakpoint
CREATE INDEX "idx_html_artifact_edit_drafts_thread" ON "html_artifact_edit_drafts" USING btree ("chat_thread_id");