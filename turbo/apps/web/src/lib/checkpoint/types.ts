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
 * VM0 volume snapshot containing version information
 */
export interface Vm0Snapshot {
  versionId: string;
}

/**
 * Volume snapshot for Git-based volumes
 */
export interface GitVolumeSnapshot {
  name: string;
  driver: "git";
  mountPath: string;
  snapshot?: GitSnapshot;
}

/**
 * Volume snapshot for VM0 managed volumes
 */
export interface Vm0VolumeSnapshot {
  name: string;
  driver: "vm0";
  mountPath: string;
  vm0VolumeName: string;
  snapshot?: Vm0Snapshot;
}

/**
 * Union type for all volume snapshots
 */
export type VolumeSnapshot = GitVolumeSnapshot | Vm0VolumeSnapshot;

/**
 * Complete checkpoint data stored in database
 */
export interface CheckpointData {
  runId: string;
  agentConfigId: string;
  sessionId: string;
  dynamicVars?: Record<string, string>;
  sessionHistory: string; // JSONL format
  volumeSnapshots: VolumeSnapshot[];
}

/**
 * Request body for checkpoint webhook endpoint
 */
export interface CheckpointRequest {
  runId: string;
  sessionId: string;
  sessionHistory: string;
  volumeSnapshots: VolumeSnapshot[];
}

/**
 * Response from checkpoint creation
 */
export interface CheckpointResponse {
  checkpointId: string;
  volumeSnapshots: number;
}
