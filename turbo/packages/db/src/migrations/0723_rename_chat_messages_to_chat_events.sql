ALTER TABLE "chat_messages" RENAME TO "chat_events";--> statement-breakpoint
ALTER INDEX "idx_chat_messages_thread_created" RENAME TO "idx_chat_events_thread_created";--> statement-breakpoint
ALTER INDEX "idx_chat_messages_thread_run_finish_created" RENAME TO "idx_chat_events_thread_run_finish_created";--> statement-breakpoint
ALTER INDEX "idx_chat_messages_run_id" RENAME TO "idx_chat_events_run_id";--> statement-breakpoint
ALTER INDEX "chat_messages_usage_run_id_idx" RENAME TO "chat_events_usage_run_id_idx";--> statement-breakpoint
ALTER INDEX "chat_messages_revokes_message_id_unique" RENAME TO "chat_events_revokes_message_id_unique";--> statement-breakpoint
ALTER INDEX "chat_messages_interrupts_run_id_unique" RENAME TO "chat_events_interrupts_run_id_unique";--> statement-breakpoint
ALTER INDEX "idx_chat_messages_run_group_id" RENAME TO "idx_chat_events_run_group_id";--> statement-breakpoint
ALTER INDEX "chat_messages_input_automation_idx" RENAME TO "chat_events_input_automation_idx";--> statement-breakpoint
ALTER INDEX "chat_messages_pending_queue_idx" RENAME TO "chat_events_pending_queue_idx";--> statement-breakpoint
ALTER INDEX "chat_messages_automation_pause_idx" RENAME TO "chat_events_automation_pause_idx";--> statement-breakpoint
ALTER INDEX "chat_messages_run_seq_unique" RENAME TO "chat_events_run_seq_unique";--> statement-breakpoint
ALTER INDEX "chat_messages_thread_seq_unique" RENAME TO "chat_events_thread_seq_unique";--> statement-breakpoint
ALTER INDEX "chat_messages_run_lifecycle_unique" RENAME TO "chat_events_run_lifecycle_unique";--> statement-breakpoint
ALTER INDEX "chat_messages_run_thinking_unique" RENAME TO "chat_events_run_thinking_unique";--> statement-breakpoint
ALTER TABLE "chat_events" RENAME CONSTRAINT "chat_messages_pkey" TO "chat_events_pkey";--> statement-breakpoint
ALTER TABLE "chat_events" RENAME CONSTRAINT "chat_messages_chat_thread_id_chat_threads_id_fk" TO "chat_events_chat_thread_id_chat_threads_id_fk";--> statement-breakpoint
ALTER TABLE "chat_events" RENAME CONSTRAINT "chat_messages_revokes_message_id_chat_messages_id_fk" TO "chat_events_revokes_message_id_chat_events_id_fk";--> statement-breakpoint
ALTER TABLE "chat_events" RENAME CONSTRAINT "chat_messages_event_type_check" TO "chat_events_event_type_check";--> statement-breakpoint
ALTER TABLE "chat_events" RENAME CONSTRAINT "chat_messages_input_user_message_check" TO "chat_events_input_user_message_check";--> statement-breakpoint
ALTER TABLE "chat_message_asset_refs" RENAME CONSTRAINT "chat_message_asset_refs_chat_message_id_chat_messages_id_fk" TO "chat_message_asset_refs_chat_message_id_chat_events_id_fk";--> statement-breakpoint
ALTER TRIGGER "chat_messages_reject_update" ON "chat_events" RENAME TO "chat_events_reject_update";--> statement-breakpoint
CREATE VIEW "chat_messages" AS SELECT * FROM "chat_events";
