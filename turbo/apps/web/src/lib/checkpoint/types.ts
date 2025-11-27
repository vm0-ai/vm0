/**
 * Checkpoint system types for preserving agent run state
 */

/**
 * VM0 artifact snapshot containing version information
 */
export interface Vm0Snapshot {
  versionId: string;
}

/**
 * Artifact snapshot for VM0 managed artifacts
 */
export interface ArtifactSnapshot {
  driver: "vm0";
  mountPath: string;
  vm0StorageName: string;
  snapshot?: Vm0Snapshot;
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
