CREATE TABLE "presentation_template_import_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "presentation_template_import_threads" ADD CONSTRAINT "presentation_template_import_threads_template_id_presentation_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."presentation_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presentation_template_import_threads" ADD CONSTRAINT "presentation_template_import_threads_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_template_import_threads_template" ON "presentation_template_import_threads" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_presentation_template_import_threads_thread" ON "presentation_template_import_threads" USING btree ("chat_thread_id");