LOCK TABLE "chat_messages" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_messages"
    WHERE "automation_id" IS NOT NULL
       OR "automation_title" IS NOT NULL
       OR "automation_snapshot" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'chat_messages legacy automation metadata must be empty before dropping columns';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "automation_id";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "automation_title";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "automation_snapshot";
