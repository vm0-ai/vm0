/**
 * Checkpoint system types for preserving agent run state
 */

/**
 * Artifact entry persisted on agent sessions and checkpoints.
 * Version is optional for session context and concrete on checkpoint payloads.
 */
export interface ContextArtifact {
  name: string;
  version?: string;
  mountPath: string;
}

/**
 * Artifact snapshot payload sent by the writer. Each entry's `version` is
 * always a resolved concrete string — distinct from `ContextArtifact`
 * (execution-context type) where `version` is optional and defaults to
 * "latest".
 */
export type ArtifactSnapshotsPayload = Array<{
  name: string;
  version: string;
  mountPath: string;
}>;

/**
 * Volume versions snapshot for checkpoint
 * Stores resolved volume versions at checkpoint time for exact reproducibility
 */
export interface VolumeVersionsSnapshot {
  // Map of volume name to resolved version ID
  versions: Record<string, string>;
  // Additional volumes with resolved versions and mount paths (for checkpoint restore)
  additionalVolumes?: Array<{
    name: string;
    versionId: string;
    mountPath: string;
  }>;
}
