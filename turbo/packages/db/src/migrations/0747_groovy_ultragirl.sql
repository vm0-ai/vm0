ALTER TABLE "chat_events" ADD COLUMN "context_type" text;--> statement-breakpoint
ALTER TABLE "chat_events" ADD COLUMN "context_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_pair_check" CHECK (("chat_events"."context_type" IS NULL) = ("chat_events"."context_id" IS NULL));--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN ('slack', 'feishu', 'automation', 'goal'));
