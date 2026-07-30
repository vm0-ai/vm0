CREATE TABLE "chat_input_queue_params" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_params" text NOT NULL,
	"attach_file_metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_input_queue_params" ADD CONSTRAINT "chat_input_queue_params_event_id_chat_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."chat_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
