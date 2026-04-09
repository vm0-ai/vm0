import type { ArtifactSnapshot } from "../checkpoint/types";
import type { Firewalls, NetworkPolicies } from "@vm0/core";

/**
 * Run status values
 */
export type RunStatus =
  | "queued"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

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
  memory?: Record<string, string>; // { memoryName: version }
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
 */
export interface ExecutionContext {
  runId: string;
  userId?: string;
  orgId: string;
  agentComposeVersionId: string;
  agentCompose: unknown;
  prompt: string;
  appendSystemPrompt?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>; // Decrypted secrets for environment expansion
  secretConnectorMap?: Record<string, string>; // Secret name → connector type for OAuth refresh
  sandboxToken: string;

  // Artifact settings (new runs only)
  artifactName?: string;
  artifactVersion?: string;

  // Memory storage name
  memoryName?: string;

  // Volume version overrides (volume name -> version)
  volumeVersions?: Record<string, string>;

  // Environment variables expanded server-side from compose's environment field
  // Uses vars and secrets to resolve ${{ vars.xxx }} and ${{ secrets.xxx }} references
  environment?: Record<string, string>;

  // User's timezone preference (IANA format, e.g., "Asia/Shanghai")
  // Injected as TZ environment variable in sandbox if not already set in environment
  userTimezone?: string;

  // Firewall for proxy-side token replacement
  firewalls?: Firewalls;

  // Per-firewall network policies
  networkPolicies?: NetworkPolicies;

  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools?: string[];

  // Tools to make available in Claude CLI (passed as --tools)
  tools?: string[];

  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings?: string;

  // Resume-specific (optional)
  resumeSession?: ResumeSession;
  resumeArtifact?: ArtifactSnapshot;

  // Metadata for vm0_start event
  agentName?: string;
  resumedFromCheckpointId?: string;
  continuedFromSessionId?: string;

  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude?: boolean;

  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies?: boolean;

  // API start time for E2E timing metrics
  apiStartTime?: number;
}

/**
 * Timing data collected during the dispatch pipeline.
 * Timestamps (absolute) use no suffix; durations (pre-computed ms) use Duration suffix.
 * Used solely for Axiom telemetry — no impact on execution.
 */
export interface DispatchTimings {
  apiStart: number;
  authorize: number;
  transaction: number;
  token: number;
  resolveSourceDuration?: number;
  resolveSecretsDuration?: number;
}
