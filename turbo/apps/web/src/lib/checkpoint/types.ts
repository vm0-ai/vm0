/**
 * Checkpoint system types for preserving agent run state
 */

/**
 * Git snapshot containing branch and commit information
 */
export interface GitSnapshot {
  branch: string;
  commitId: string;
}

/**
 * VM0 artifact snapshot containing version information
 */
export interface Vm0Snapshot {
  versionId: string;
}

/**
 * Artifact snapshot for Git-based artifacts
 */
export interface GitArtifactSnapshot {
  driver: "git";
  mountPath: string;
  snapshot?: GitSnapshot;
}

/**
 * Artifact snapshot for VM0 managed artifacts
 */
export interface Vm0ArtifactSnapshot {
  driver: "vm0";
  mountPath: string;
  vm0VolumeName: string;
  snapshot?: Vm0Snapshot;
}

/**
 * Union type for artifact snapshots
 */
export type ArtifactSnapshot = GitArtifactSnapshot | Vm0ArtifactSnapshot;

/**
 * Complete checkpoint data stored in database
 */
export interface CheckpointData {
  runId: string;
  agentConfigId: string;
  sessionId: string;
  dynamicVars?: Record<string, string>;
  sessionHistory: string; // JSONL format
  artifactSnapshot: ArtifactSnapshot | null;
}

/**
 * Request body for checkpoint webhook endpoint
 */
export interface CheckpointRequest {
  runId: string;
  sessionId: string;
  sessionHistory: string;
  artifactSnapshot: ArtifactSnapshot | null;
}

/**
 * Response from checkpoint creation
 */
export interface CheckpointResponse {
  checkpointId: string;
  hasArtifact: boolean;
}

// Legacy types for backward compatibility during migration
// TODO: Remove after full migration

/**
 * @deprecated Use ArtifactSnapshot instead
 */
export interface GitVolumeSnapshot {
  name: string;
  driver: "git";
  mountPath: string;
  snapshot?: GitSnapshot;
}

/**
 * @deprecated Use ArtifactSnapshot instead
 */
export interface Vm0VolumeSnapshot {
  name: string;
  driver: "vm0";
  mountPath: string;
  vm0VolumeName: string;
  snapshot?: Vm0Snapshot;
}

/**
 * @deprecated Use ArtifactSnapshot instead
 */
export type VolumeSnapshot = GitVolumeSnapshot | Vm0VolumeSnapshot;
