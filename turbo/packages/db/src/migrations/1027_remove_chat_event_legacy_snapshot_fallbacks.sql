-- Contract the converged Chat Event Snapshot pointer set to canonical V7.
-- Immutable R2 objects are intentionally untouched here. The permanent,
-- reference-aware R2 garbage collector owns deletion after its grace period.
SET LOCAL statement_timeout = '2min';--> statement-breakpoint
DO $$
DECLARE
  uncovered_legacy_count bigint;
  future_version_count bigint;
BEGIN
  SELECT count(*)
  INTO uncovered_legacy_count
  FROM (
    SELECT 1
    FROM "chat_event_snapshots" AS legacy
    WHERE legacy."archive_schema_version" < 7
      AND NOT EXISTS (
        SELECT 1
        FROM "chat_event_snapshots" AS canonical
        WHERE canonical."chat_thread_id" = legacy."chat_thread_id"
          AND canonical."archive_schema_version" = 7
          AND canonical."projection" = 'tool-redacted'
          AND canonical."last_seq_id" >= legacy."last_seq_id"
          AND canonical."object_key" ~
            '^chat-events/[0-9a-f-]{36}/[0-9]+-[0-9a-f]{64}[.]ndjson[.]gz$'
      )
    LIMIT 1000
  ) AS uncovered_legacy;

  SELECT count(*)
  INTO future_version_count
  FROM (
    SELECT 1
    FROM "chat_event_snapshots"
    WHERE "archive_schema_version" > 7
    LIMIT 1000
  ) AS future_versions;

  IF uncovered_legacy_count > 0 OR future_version_count > 0 THEN
    RAISE EXCEPTION
      'Chat Event Snapshot V7 contraction blocked: uncovered_legacy=%, future_version=%',
      uncovered_legacy_count,
      future_version_count;
  END IF;
END;
$$;--> statement-breakpoint

DELETE FROM "chat_event_snapshots"
WHERE "archive_schema_version" < 7;--> statement-breakpoint
SET LOCAL statement_timeout = '10s';
