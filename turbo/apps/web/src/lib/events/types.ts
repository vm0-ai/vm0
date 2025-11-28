/**
 * VM0 system event types
 * These events represent run lifecycle management, separate from agent execution events
 */

/**
 * Artifact info for display
 */
export interface Vm0ArtifactInfo {
  name: string;
  version: string;
}

/**
 * VM0 Start Event
 * Sent when a run is created and starting
 */
export interface Vm0StartEvent {
  type: "vm0_start";
  runId: string;
  agentConfigId: string;
  agentName?: string;
  prompt: string;
  templateVars?: Record<string, unknown>;
  resumedFromCheckpointId?: string;
  continuedFromSessionId?: string;
  artifact?: Vm0ArtifactInfo;
  volumes?: Record<string, string>;
  timestamp: string;
}

/**
 * VM0 Result Event
 * Sent when a run completes successfully
 */
export interface Vm0ResultEvent {
  type: "vm0_result";
  runId: string;
  status: "completed";
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
  artifact: Vm0ArtifactInfo;
  volumes?: Record<string, string>;
  timestamp: string;
}

/**
 * VM0 Error Event
 * Sent when a run fails
 */
export interface Vm0ErrorEvent {
  type: "vm0_error";
  runId: string;
  status: "failed";
  error: string;
  errorType?: "sandbox_error" | "checkpoint_failed" | "timeout" | "unknown";
  sandboxId?: string;
  timestamp: string;
}

/**
 * Union type for all VM0 events
 */
export type Vm0Event = Vm0StartEvent | Vm0ResultEvent | Vm0ErrorEvent;
