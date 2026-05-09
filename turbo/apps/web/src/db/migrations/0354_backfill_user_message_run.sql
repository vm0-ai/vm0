INSERT INTO "user_message_run" ("user_message_id", "run_id", "created_at")
SELECT "id", "run_id", "created_at"
FROM "chat_messages"
WHERE "role" = 'user'
  AND "run_id" IS NOT NULL
ON CONFLICT ("user_message_id") DO NOTHING;
--> statement-breakpoint
UPDATE "chat_messages"
SET "run_id" = NULL
WHERE "role" = 'user'
  AND "run_id" IS NOT NULL;
