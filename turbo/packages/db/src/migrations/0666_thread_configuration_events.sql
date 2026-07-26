ALTER TYPE "public"."chat_thread_event_kind" ADD VALUE 'service_tier_updated' BEFORE 'sort_touched';--> statement-breakpoint
ALTER TYPE "public"."chat_thread_event_kind" ADD VALUE 'computer_use_host_updated' BEFORE 'sort_touched';--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN "service_tier" varchar(20);--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN "computer_use_host_id" uuid;