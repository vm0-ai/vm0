ALTER TABLE "run_uploaded_files" ADD COLUMN "preview_status" varchar(32);--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "preview_error" jsonb;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "preview_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" ADD COLUMN "preview_updated_at" timestamp;