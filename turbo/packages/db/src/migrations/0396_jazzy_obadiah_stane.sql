ALTER TABLE "chat_threads" ADD COLUMN "last_message_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "chat_threads" SET "last_message_at" = COALESCE(
  (SELECT MAX("created_at") FROM "chat_messages" WHERE "chat_messages"."chat_thread_id" = "chat_threads"."id"),
  "chat_threads"."created_at"
);--> statement-breakpoint
CREATE INDEX "idx_chat_threads_user_compose_last_message" ON "chat_threads" USING btree ("user_id","agent_compose_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "archived_at";
