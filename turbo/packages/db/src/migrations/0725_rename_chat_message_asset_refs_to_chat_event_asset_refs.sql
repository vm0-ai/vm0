ALTER TABLE "chat_message_asset_refs" RENAME TO "chat_event_asset_refs";--> statement-breakpoint
ALTER TABLE "chat_event_asset_refs" RENAME COLUMN "chat_message_id" TO "chat_event_id";--> statement-breakpoint
ALTER TABLE "chat_event_asset_refs" RENAME CONSTRAINT "chat_message_asset_refs_pk" TO "chat_event_asset_refs_pk";--> statement-breakpoint
ALTER INDEX "chat_message_asset_refs_message_position_unique" RENAME TO "chat_event_asset_refs_event_position_unique";--> statement-breakpoint
ALTER INDEX "chat_message_asset_refs_asset_idx" RENAME TO "chat_event_asset_refs_asset_idx";--> statement-breakpoint
ALTER TABLE "chat_event_asset_refs" RENAME CONSTRAINT "chat_message_asset_refs_chat_message_id_chat_events_id_fk" TO "chat_event_asset_refs_chat_event_id_chat_events_id_fk";--> statement-breakpoint
ALTER TABLE "chat_event_asset_refs" RENAME CONSTRAINT "chat_message_asset_refs_asset_id_run_uploaded_files_id_fk" TO "chat_event_asset_refs_asset_id_run_uploaded_files_id_fk";--> statement-breakpoint
CREATE VIEW "chat_message_asset_refs" AS
SELECT *, "chat_event_id" AS "chat_message_id"
FROM "chat_event_asset_refs";
