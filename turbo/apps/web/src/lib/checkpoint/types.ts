/**
 * Checkpoint system types for preserving agent run state
 */

/**
 * Agent compose snapshot stored in checkpoint
 * Uses version ID for reproducibility (content-addressed versioning)
 */
export interface AgentComposeSnapshot {
  agentComposeVersionId: string; // SHA-256 hash of compose content
  templateVars?: Record<string, string>;
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
}

/**
 * Conversation data for CLI agent session
 */
export interface ConversationData {
  runId: string;
  cliAgentType: string;
  cliAgentSessionId: string;
  cliAgentSessionHistory: string;
}

/**
 * Complete checkpoint data stored in database
 */
export interface CheckpointData {
  runId: string;
  conversationId: string;
  agentComposeSnapshot: AgentComposeSnapshot;
  artifactSnapshot: ArtifactSnapshot;
  volumeVersionsSnapshot?: VolumeVersionsSnapshot;
}

/**
 * Request body for checkpoint webhook endpoint
 */
export interface CheckpointRequest {
  runId: string;
  cliAgentType: string;
  cliAgentSessionId: string;
  cliAgentSessionHistory: string;
  artifactSnapshot: ArtifactSnapshot;
  volumeVersionsSnapshot?: VolumeVersionsSnapshot;
}

/**
 * Response from checkpoint creation
 */
export interface CheckpointResponse {
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
  artifact: ArtifactSnapshot;
  volumes?: Record<string, string>;
}
