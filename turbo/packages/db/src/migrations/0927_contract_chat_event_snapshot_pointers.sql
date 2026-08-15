-- Retain the greatest terminal watermark for every thread/version pair.
-- Equal watermarks preserve the existing reader order: the rollout head,
-- then the newest creation time, then the greatest UUID. Production had no
-- equal-watermark duplicate groups when this contraction was prepared, but
-- the ordering keeps the transition deterministic if one races the migration.
WITH "ranked_chat_event_snapshot_pointers" AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "chat_thread_id", "archive_schema_version"
      ORDER BY
        "last_seq_id" DESC,
        "is_head" DESC,
        "created_at" DESC,
        "id" DESC
    ) AS "retention_rank"
  FROM "chat_event_snapshots"
)
DELETE FROM "chat_event_snapshots" AS "snapshot"
USING "ranked_chat_event_snapshot_pointers" AS "ranked"
WHERE "snapshot"."id" = "ranked"."id"
  AND "ranked"."retention_rank" > 1;
--> statement-breakpoint

-- Migration 0923 backfilled every cursor and kept later legacy writes filled
-- by trigger. Do not synthesize a terminal identity during contraction: an
-- unexpected NULL must stop deployment for investigation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "chat_event_snapshots"
    WHERE "last_event_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'A Chat Event Snapshot has no terminal event ID';
  END IF;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "chat_event_snapshots_fill_last_event_id"
ON "chat_event_snapshots";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "set_chat_event_snapshot_last_event_id"();
