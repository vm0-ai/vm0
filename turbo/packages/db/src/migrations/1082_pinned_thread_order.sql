ALTER TABLE "chat_thread_events" ADD COLUMN "pin_order" text;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "pin_order" text;