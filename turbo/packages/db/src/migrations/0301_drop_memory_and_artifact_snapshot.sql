-- Epic #10577 Phase 3 final cleanup (#10603): drop legacy singleton
-- artifact_snapshot + unused memory_snapshot JSONB columns on checkpoints.
--
-- Backfill policy (decided in the innovate phase):
--   - artifact_snapshot (singleton): fold into artifact_snapshots when the
--     row has the singleton but not the map. Singleton has live readers
--     (resolve-checkpoint, webhooks/agent/complete) that fall back to it
--     for pre-multi-mount rows, so the data is load-bearing.
--   - memory_snapshot: dropped raw. Zero readers post-#10602; its only
--     downstream consumer (agent_sessions.memory_name) is populated
--     eagerly at run creation, not from this column.

-- Pre-flight: log backfill scope so we can audit post-deploy.
DO $$
DECLARE
  singleton_rows BIGINT;
  memory_rows BIGINT;
BEGIN
  SELECT COUNT(*) INTO singleton_rows FROM checkpoints
    WHERE artifact_snapshot IS NOT NULL
      AND (artifact_snapshots IS NULL OR artifact_snapshots = '{}'::jsonb);
  SELECT COUNT(*) INTO memory_rows FROM checkpoints
    WHERE memory_snapshot IS NOT NULL;
  RAISE NOTICE 'migration 0299: backfilling % singleton rows, dropping % memory_snapshot rows', singleton_rows, memory_rows;
END $$;--> statement-breakpoint

-- Fold the legacy singleton into the multi-entry map for rows that only
-- have the singleton. jsonb_build_object returns a single-key object
-- derived from the singleton's {artifactName, artifactVersion} fields.
UPDATE checkpoints
SET artifact_snapshots = jsonb_build_object(
  artifact_snapshot->>'artifactName',
  artifact_snapshot->>'artifactVersion'
)
WHERE artifact_snapshot IS NOT NULL
  AND (artifact_snapshots IS NULL OR artifact_snapshots = '{}'::jsonb);--> statement-breakpoint

ALTER TABLE "checkpoints" DROP COLUMN "artifact_snapshot";--> statement-breakpoint
ALTER TABLE "checkpoints" DROP COLUMN "memory_snapshot";
