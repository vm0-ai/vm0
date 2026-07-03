UPDATE "checkpoints"
SET "artifact_snapshots" = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', kv.key,
      'version', kv.value,
      'mountPath', CASE
        WHEN kv.key = 'memory'
          THEN '/home/user/.claude/projects/-home-user-workspace/memory'
        ELSE '/home/user/workspace'
      END
    )
  )
  FROM jsonb_each_text("artifact_snapshots") kv
)
WHERE jsonb_typeof("artifact_snapshots") = 'object';--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "agent_sessions"
SET "artifacts" = COALESCE((
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', n.value,
      'version', 'latest',
      'mountPath', CASE
        WHEN n.value = 'memory'
          THEN '/home/user/.claude/projects/-home-user-workspace/memory'
        ELSE '/home/user/workspace'
      END
    )
  )
  FROM jsonb_array_elements_text("artifact_names") n(value)
), '[]'::jsonb);--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "artifact_names";
