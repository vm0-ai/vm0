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
-- The currently deployed bridge-bearing API can still issue cleanup DELETEs
-- while this migration runs before the bridge-free API is promoted. Pre-cutover
-- APIs that INSERT legacy queue rows have already drained. Keep a zero-row,
-- DELETE-only compatibility relation for one release so those cleanup
-- transactions remain successful without retaining legacy storage.
CREATE VIEW "chat_message_queue" AS
SELECT
  NULL::uuid AS "id",
  NULL::uuid AS "chat_thread_id",
  NULL::uuid AS "chat_message_id",
  NULL::text AS "item_type"
WHERE FALSE;--> statement-breakpoint
CREATE FUNCTION "ignore_legacy_chat_message_queue_delete_0719"() RETURNS trigger AS $$
BEGIN
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "ignore_legacy_chat_message_queue_delete_0719"
INSTEAD OF DELETE ON "chat_message_queue"
FOR EACH ROW
EXECUTE FUNCTION "ignore_legacy_chat_message_queue_delete_0719"();--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "queue_paused_at";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "pause_reason";--> statement-breakpoint
DROP TYPE "public"."chat_message_queue_item_type";
