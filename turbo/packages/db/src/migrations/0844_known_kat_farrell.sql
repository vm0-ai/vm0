CREATE TABLE "shared_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"source_chat_thread_id" uuid,
	"title" text NOT NULL,
	"messages" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "projection_file_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_threads" ADD CONSTRAINT "shared_threads_source_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("source_chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_threads_user_created_idx" ON "shared_threads" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shared_threads_source_created_idx" ON "shared_threads" USING btree ("source_chat_thread_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);