ALTER TABLE "chat_output_materializations" ADD COLUMN "pending_sequence_numbers" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD COLUMN "latest_result_text" text;--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD COLUMN "latest_output_sequence" integer;--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD COLUMN "latest_output_text" text;
