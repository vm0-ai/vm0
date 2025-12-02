/**
 * Agent run types
 */

export interface CreateAgentRunRequest {
  agentComposeVersionId: string; // Immutable compose version ID (SHA-256 hash)
  prompt: string;
  templateVars?: Record<string, string>;
  artifactName: string; // Required: artifact storage name
  artifactVersion?: string; // Optional: version hash (defaults to "latest")
  volumeVersions?: Record<string, string>; // Optional: volume name -> version overrides
}

/**
 * Unified run request - supports all run modes via optional parameters
 * Shortcuts (checkpointId, sessionId) expand to base parameters
 */
export interface UnifiedRunRequest {
  // High-level shortcuts (mutually exclusive with each other)
  checkpointId?: string; // Expand checkpoint snapshot parameters
  sessionId?: string; // Expand session parameters (artifact version forced to "latest")

  // Base parameters (can be used directly or overridden after shortcut expansion)
  agentComposeId?: string; // Agent compose ID (resolves to HEAD version)
  agentComposeVersionId?: string; // Explicit compose version ID (SHA-256 hash)
  conversationId?: string; // Conversation to resume from
  artifactName?: string; // Artifact storage name
  artifactVersion?: string; // Artifact version (default: "latest")
  templateVars?: Record<string, string>; // Template variables
  volumeVersions?: Record<string, string>; // Volume name -> version overrides

  // Required
  prompt: string;
}

export interface CreateAgentRunResponse {
  runId: string;
  status: "pending" | "running" | "completed" | "failed";
  sandboxId?: string;
  output?: string;
  error?: string;
  executionTimeMs?: number;
  createdAt: string;
}

export interface GetAgentRunResponse {
  runId: string;
  agentComposeVersionId: string; // Immutable compose version ID
  status: "pending" | "running" | "completed" | "failed";
  prompt: string;
  templateVars?: Record<string, string>;
  sandboxId?: string;
  result?: {
    output: string;
    executionTimeMs: number;
  };
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
