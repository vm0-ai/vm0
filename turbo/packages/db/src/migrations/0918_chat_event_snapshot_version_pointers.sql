LOCK TABLE "chat_event_snapshots" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
WITH "ranked_snapshots" AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "chat_thread_id", "archive_schema_version"
      ORDER BY "last_seq_id" DESC, "is_head" DESC, "created_at" DESC, "id" DESC
    ) AS "snapshot_rank"
  FROM "chat_event_snapshots"
)
DELETE FROM "chat_event_snapshots"
USING "ranked_snapshots"
WHERE "chat_event_snapshots"."id" = "ranked_snapshots"."id"
  AND "ranked_snapshots"."snapshot_rank" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_event_snapshots_thread_version_unique" ON "chat_event_snapshots" USING btree ("chat_thread_id", "archive_schema_version");
