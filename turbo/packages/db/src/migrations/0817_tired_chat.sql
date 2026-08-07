UPDATE "chat_telegram_context"
SET "chat_type" = 'private'
WHERE "chat_type" IS NULL
  AND "is_dm";--> statement-breakpoint
ALTER TABLE "chat_telegram_context" ALTER COLUMN "chat_type" SET NOT NULL;
