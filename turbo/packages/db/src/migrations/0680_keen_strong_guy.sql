ALTER TABLE "agent_runs" DROP COLUMN "additional_volumes";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "artifacts";--> statement-breakpoint
ALTER TABLE "checkpoints" DROP COLUMN "artifact_snapshots";--> statement-breakpoint
ALTER TABLE "checkpoints" DROP COLUMN "volume_versions_snapshot";