/**
 * Checkpoint system types for preserving agent run state
 */

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
 * Artifact snapshot for VAS managed artifacts
 * Fields align with CLI parameters --artifact-name and --artifact-version
 */
export interface ArtifactSnapshot {
  artifactName: string;
  artifactVersion: string;
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

/**
 * Request body for checkpoint webhook endpoint
 */
export interface CheckpointRequest {
  runId: string;
  cliAgentType: string;
  cliAgentSessionId: string;
  cliAgentSessionHistoryHash: string;
  artifactSnapshot?: ArtifactSnapshot;
  // Multi-artifact snapshot map: artifactName -> versionId. Emitted
  // unconditionally by the guest-agent during the multi-mount rollout;
  // may be empty or missing when the guest snapshotted nothing.
  artifactSnapshots?: Record<string, string>;
  volumeVersionsSnapshot?: VolumeVersionsSnapshot;
}

/**
 * Response from checkpoint creation
 */
export interface CheckpointResponse {
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
  artifact?: ArtifactSnapshot;
  artifacts?: Record<string, string>;
  volumes?: Record<string, string>;
}
