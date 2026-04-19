ALTER TABLE "chat_threads" ADD COLUMN "last_read_at" timestamp;--> statement-breakpoint
UPDATE "chat_threads" SET "last_read_at" = "updated_at";--> statement-breakpoint
CREATE INDEX "idx_chat_threads_user_last_read" ON "chat_threads" USING btree ("user_id","last_read_at");--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "read_at";