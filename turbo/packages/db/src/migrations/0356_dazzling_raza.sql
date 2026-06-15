ALTER TABLE "chat_messages" ADD COLUMN "revokes_message_id" uuid;--> statement-breakpoint
UPDATE "chat_messages" AS cm
SET "run_id" = umr."run_id"
FROM "user_message_run" AS umr
WHERE cm."id" = umr."user_message_id"
  AND cm."run_id" IS NULL;--> statement-breakpoint
ALTER TABLE "user_message_run" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "user_message_run" CASCADE;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_revokes_message_id_chat_messages_id_fk" FOREIGN KEY ("revokes_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_revokes_message_id_unique" ON "chat_messages" USING btree ("revokes_message_id");
