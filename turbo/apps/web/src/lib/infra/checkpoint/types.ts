/**
 * Checkpoint system types for preserving agent run state
 */

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
 * Agent compose snapshot stored in checkpoint
 * Uses version ID for reproducibility (content-addressed versioning)
 * Note: Environment is re-expanded from vars/secrets on resume, not stored
 * Note: Secrets values are never persisted - only names for validation
 */
export interface AgentComposeSnapshot {
  agentComposeVersionId: string; // SHA-256 hash of compose content
  vars?: Record<string, string>;
  secretNames?: string[]; // Secret names only (for validation), values never stored
}

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
