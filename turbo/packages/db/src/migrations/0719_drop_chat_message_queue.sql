DROP TRIGGER "mirror_legacy_chat_queue_insert_0714" ON "chat_message_queue";--> statement-breakpoint
DROP TRIGGER "mirror_legacy_chat_queue_delete_0714" ON "chat_message_queue";--> statement-breakpoint
DROP TRIGGER "project_chat_queue_pause_event_0714" ON "chat_messages";--> statement-breakpoint
DROP TRIGGER "mirror_legacy_chat_queue_pause_0714" ON "chat_threads";--> statement-breakpoint
DROP FUNCTION "mirror_legacy_chat_queue_insert_0714"();--> statement-breakpoint
DROP FUNCTION "mirror_legacy_chat_queue_delete_0714"();--> statement-breakpoint
DROP FUNCTION "project_chat_queue_pause_event_0714"();--> statement-breakpoint
DROP FUNCTION "mirror_legacy_chat_queue_pause_0714"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_chat_event_source_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TABLE "chat_message_queue";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "queue_paused_at";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "pause_reason";--> statement-breakpoint
DROP TYPE "public"."chat_message_queue_item_type";
