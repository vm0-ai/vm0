/**
 * Checkpoint system types for preserving agent run state
 */

import type { AgentConfigYaml } from "../../types/agent-config";

/**
 * Agent configuration snapshot stored in checkpoint
 * Contains full config for reproducibility (configs have no versioning)
 */
export interface AgentConfigSnapshot {
  config: AgentConfigYaml;
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
  agentConfigSnapshot: AgentConfigSnapshot;
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
  hasArtifact: boolean;
}
