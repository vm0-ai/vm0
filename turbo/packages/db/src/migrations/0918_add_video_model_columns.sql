ALTER TYPE "public"."chat_thread_event_kind" ADD VALUE 'video_model_updated' BEFORE 'sort_touched';--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN "selected_video_model" varchar(255);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "selected_video_model" varchar(255);--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD COLUMN "selected_video_model" varchar(255);--> statement-breakpoint
ALTER TABLE "zero_runs" ADD COLUMN "selected_video_model" varchar(255);