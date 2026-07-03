-- Backfill agent_sessions.artifacts with the memory entry for sessions
-- created before Zero started seeding it at insertion time. Source: the
-- most recent checkpoint whose artifact_snapshots contains a "memory"
-- entry. Sessions with no such checkpoint are left alone — they have
-- never successfully mounted memory and there is nothing to restore.
--
-- Without this backfill, resume of an affected session builds a manifest
-- without memory, which the runner's reuse-path cleanup logic treats as
-- "artifact removed since last turn" and wipes the memory mount without
-- re-downloading.

DO $$
DECLARE
  affected BIGINT;
BEGIN
  SELECT COUNT(*) INTO affected
  FROM agent_sessions s
  WHERE NOT (s.artifacts @> '[{"name":"memory"}]'::jsonb)
    AND EXISTS (
      SELECT 1
      FROM checkpoints c
      JOIN agent_runs r ON r.id = c.run_id
      WHERE r.session_id = s.id
        AND c.artifact_snapshots @> '[{"name":"memory"}]'::jsonb
    );
  RAISE NOTICE 'migration 0311: backfilling memory artifact into % agent_sessions rows', affected;
END $$;--> statement-breakpoint

UPDATE agent_sessions AS s
SET artifacts = s.artifacts || (
  SELECT (
    SELECT entry
    FROM jsonb_array_elements(c.artifact_snapshots) AS entry
    WHERE entry->>'name' = 'memory'
    LIMIT 1
  )
  FROM checkpoints c
  JOIN agent_runs r ON r.id = c.run_id
  WHERE r.session_id = s.id
    AND c.artifact_snapshots @> '[{"name":"memory"}]'::jsonb
  ORDER BY c.created_at DESC
  LIMIT 1
)
WHERE NOT (s.artifacts @> '[{"name":"memory"}]'::jsonb)
  AND EXISTS (
    SELECT 1
    FROM checkpoints c
    JOIN agent_runs r ON r.id = c.run_id
    WHERE r.session_id = s.id
      AND c.artifact_snapshots @> '[{"name":"memory"}]'::jsonb
  );
