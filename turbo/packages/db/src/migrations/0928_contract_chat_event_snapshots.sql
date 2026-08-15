-- Keep the greatest Snapshot watermark for each thread and schema version.
-- Equal watermarks follow the existing reader identity: the current head,
-- then newest created_at, then greatest UUID. The production audit found no
-- equal-watermark duplicate.
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
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
