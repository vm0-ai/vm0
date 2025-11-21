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
 * Volume snapshot for Git-based volumes
 */
export interface VolumeSnapshot {
  name: string;
  driver: "git";
  mountPath: string;
  snapshot?: GitSnapshot;
}

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
