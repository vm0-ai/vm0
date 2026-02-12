import type { ArtifactSnapshot } from "../checkpoint/types";
import type { ExperimentalFirewall } from "@vm0/core";

/**
 * Run status values
 */
export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout";

/**
 * Run result stored in agent_runs.result when status = 'completed'
 * Contains checkpoint and artifact information for session continuation
 */
export interface RunResult {
  checkpointId: string;
  agentSessionId: string;
  conversationId: string;
  artifact?: Record<string, string>; // { artifactName: version } - optional when run has no artifact
  volumes?: Record<string, string>; // { volumeName: version }
}

/**
 * Run state information returned by events API
 * Replaces the previous vm0_start/vm0_result/vm0_error events
 */
export interface RunState {
  status: RunStatus;
  result?: RunResult; // Present when status = 'completed'
  error?: string; // Present when status = 'failed'
}

/**
 * Session history restoration data
 */
export interface ResumeSession {
  sessionId: string;
  sessionHistory: string; // JSONL content
  workingDir: string; // Working directory for session path calculation
}

/**
 * Unified execution context for both new runs and resumed runs
 * This abstraction allows e2b-service to be agnostic about run type
 */
export interface ExecutionContext {
  runId: string;
  userId?: string;
  agentComposeVersionId: string;
  agentCompose: unknown;
  prompt: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>; // Decrypted secrets for environment expansion
  secretNames?: string[]; // Secret names for validation (values from secrets param are used for client-side masking)
  sandboxToken: string;

  // Artifact settings (new runs only)
  artifactName?: string;
  artifactVersion?: string;

  // Volume version overrides (volume name -> version)
  volumeVersions?: Record<string, string>;

  // Environment variables expanded server-side from compose's environment field
  // Uses vars and secrets to resolve ${{ vars.xxx }} and ${{ secrets.xxx }} references
  environment?: Record<string, string>;

  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  // Injected as TZ environment variable in sandbox if not already set in environment
  userTimezone?: string;

  // Experimental firewall configuration for network egress control
  experimentalFirewall?: ExperimentalFirewall;

  // Resume-specific (optional)
  resumeSession?: ResumeSession;
  resumeArtifact?: ArtifactSnapshot;

  // Metadata for vm0_start event
  agentName?: string;
  resumedFromCheckpointId?: string;
  continuedFromSessionId?: string;

  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude?: boolean;

  // API start time for E2E timing metrics
  apiStartTime?: number;
}
