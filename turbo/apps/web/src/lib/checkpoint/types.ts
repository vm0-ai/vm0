/**
 * Checkpoint system types for preserving agent run state
 */

/**
 * VAS artifact snapshot containing version information
 */
export interface VasSnapshot {
  versionId: string;
}

/**
 * Artifact snapshot for VAS managed artifacts
 */
export interface ArtifactSnapshot {
  driver: "vas";
  mountPath: string;
  vasStorageName: string;
  snapshot?: VasSnapshot;
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
