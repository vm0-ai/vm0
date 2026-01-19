-- Rename volume_snapshots column to artifact_snapshot in checkpoints table
ALTER TABLE "checkpoints" RENAME COLUMN "volume_snapshots" TO "artifact_snapshot";
