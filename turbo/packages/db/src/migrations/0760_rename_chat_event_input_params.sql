ALTER TABLE "chat_input_queue_params" RENAME TO "chat_event_input_params";--> statement-breakpoint
ALTER TABLE "chat_event_input_params" RENAME CONSTRAINT "chat_input_queue_params_pkey" TO "chat_event_input_params_pkey";--> statement-breakpoint
ALTER TABLE "chat_event_input_params" RENAME CONSTRAINT "chat_input_queue_params_event_id_chat_events_id_fk" TO "chat_event_input_params_event_id_chat_events_id_fk";
