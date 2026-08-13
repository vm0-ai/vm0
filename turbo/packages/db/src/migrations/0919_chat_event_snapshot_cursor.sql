ALTER TABLE "chat_event_snapshots" ADD COLUMN "last_event_id" uuid;
--> statement-breakpoint
UPDATE "chat_event_snapshots" AS "snapshot"
SET "last_event_id" = (
  SELECT "chat_events"."id"
  FROM "chat_events"
  WHERE "chat_events"."chat_thread_id" = "snapshot"."chat_thread_id"
    AND "chat_events"."seq_id" <= "snapshot"."last_seq_id"
  ORDER BY "chat_events"."seq_id" DESC
  LIMIT 1
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_event_snapshots"
    WHERE "last_event_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'A Chat Event Snapshot has no physical event at or before its cursor';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ALTER COLUMN "last_event_id" SET NOT NULL;
