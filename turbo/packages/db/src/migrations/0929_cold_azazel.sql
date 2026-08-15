SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';
--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" DROP CONSTRAINT "chat_event_snapshots_parent_snapshot_id_chat_event_snapshots_id_fk";
--> statement-breakpoint
-- Close the race between the online preparation migration and this locked
-- contraction with the same deterministic winner order.
WITH "ranked_snapshots" AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "chat_thread_id", "archive_schema_version"
      ORDER BY
        "last_seq_id" DESC,
        "is_head" DESC,
        "created_at" DESC,
        "id" DESC
    ) AS "snapshot_rank"
  FROM "chat_event_snapshots"
)
DELETE FROM "chat_event_snapshots"
USING "ranked_snapshots"
WHERE "chat_event_snapshots"."id" = "ranked_snapshots"."id"
  AND "ranked_snapshots"."snapshot_rank" > 1;
--> statement-breakpoint
DROP INDEX "chat_event_snapshots_thread_head_unique";--> statement-breakpoint
DROP INDEX "chat_event_snapshots_thread_version_idx";--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ALTER COLUMN "last_event_id" SET NOT NULL;--> statement-breakpoint
DROP TRIGGER "chat_event_snapshots_fill_last_event_id" ON "chat_event_snapshots";--> statement-breakpoint
DROP FUNCTION "set_chat_event_snapshot_last_event_id"();--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_snapshots_thread_version_unique" ON "chat_event_snapshots" USING btree ("chat_thread_id","archive_schema_version");--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" DROP COLUMN "parent_snapshot_id";--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" DROP COLUMN "is_head";
