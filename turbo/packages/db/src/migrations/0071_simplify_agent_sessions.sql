-- Simplify agent_sessions: remove snapshotted fields
-- Sessions now always use HEAD compose version at runtime
-- Vars, secrets, and volumes are resolved from their respective services

ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "agent_compose_version_id";
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "vars";
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "secret_names";
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "volume_versions";
