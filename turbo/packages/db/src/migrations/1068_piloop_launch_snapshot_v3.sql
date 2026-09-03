-- vm0:non-transactional
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_launch_snapshot_v3_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_launch_snapshot_v3_check" CHECK ((
  "agent_runs"."launch_snapshot" IS NULL OR (
    jsonb_typeof("agent_runs"."launch_snapshot") = 'object' AND
    jsonb_typeof("agent_runs"."launch_snapshot" -> 'framework') = 'string' AND
    "agent_runs"."launch_snapshot" ->> 'framework' = ANY (ARRAY['claude-code', 'codex', 'pi']) AND
    jsonb_typeof("agent_runs"."launch_snapshot" -> 'runnerProfile') = 'string' AND
    char_length("agent_runs"."launch_snapshot" ->> 'runnerProfile') >= 1 AND
    char_length("agent_runs"."launch_snapshot" ->> 'runnerProfile') <= 255 AND
    (
      (
        "agent_runs"."launch_snapshot" ?& ARRAY['schemaVersion', 'framework', 'runnerProfile'] AND
        ("agent_runs"."launch_snapshot" - 'schemaVersion' - 'framework' - 'runnerProfile') = '{}'::jsonb AND
        "agent_runs"."launch_snapshot" -> 'schemaVersion' = '1'::jsonb
      ) OR (
        "agent_runs"."launch_snapshot" ?& ARRAY['schemaVersion', 'framework', 'runnerProfile', 'piMemoryGenerationEnabled'] AND
        ("agent_runs"."launch_snapshot" - 'schemaVersion' - 'framework' - 'runnerProfile' - 'piMemoryGenerationEnabled') = '{}'::jsonb AND
        "agent_runs"."launch_snapshot" -> 'schemaVersion' = '2'::jsonb AND
        jsonb_typeof("agent_runs"."launch_snapshot" -> 'piMemoryGenerationEnabled') = 'boolean'
      ) OR (
        "agent_runs"."launch_snapshot" ?& ARRAY['schemaVersion', 'framework', 'runnerProfile'] AND
        ("agent_runs"."launch_snapshot" - 'schemaVersion' - 'framework' - 'runnerProfile') = '{}'::jsonb AND
        "agent_runs"."launch_snapshot" -> 'schemaVersion' = '3'::jsonb
      )
    )
  )
)) NOT VALID;--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_launch_snapshot_v3_check";--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_launch_snapshot_check";--> statement-breakpoint
ALTER TABLE "agent_runs" RENAME CONSTRAINT "agent_runs_launch_snapshot_v3_check" TO "agent_runs_launch_snapshot_check";--> statement-breakpoint
COMMIT;
