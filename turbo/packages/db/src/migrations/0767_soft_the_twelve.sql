ALTER TABLE "chat_output_materializations" ADD COLUMN "latest_result_text" text;--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD COLUMN "latest_output_sequence" integer;--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD COLUMN "latest_output_text" text;
