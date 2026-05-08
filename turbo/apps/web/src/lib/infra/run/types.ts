import type { AdditionalVolume } from "../storage/types";
import type {
  Firewalls,
  NetworkPolicies,
} from "@vm0/connectors/firewall-types";
import type { SecretConnectorMetadata } from "@vm0/api-contracts/contracts/runners";

/**
 * Artifact entry on an ExecutionContext: a name, optional version
 * ("latest" when undefined), and an explicit mount path.
 */
export interface ContextArtifact {
  name: string;
  version?: string;
  mountPath: string;
}

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
  secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>; // Secret name → refresh owner metadata
  sandboxToken: string;

  // Artifacts: unified list where every entry carries its own mountPath.
  // Version is optional — undefined means "latest". New runs use undefined or
  // "latest"; resume paths inject concrete version IDs from snapshots.
  artifacts?: ContextArtifact[];

  // Volume version overrides (volume name -> version)
  volumeVersions?: Record<string, string>;

  // Additional volumes passed at run time (bypass compose)
  additionalVolumes?: AdditionalVolume[];

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

  // Metadata for vm0_start event
  agentName?: string;
  resumedFromCheckpointId?: string;
  continuedFromSessionId?: string;

  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude?: boolean;

  // Debug flag to force real Codex in mock environments (internal use only)
  debugNoMockCodex?: boolean;

  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies?: boolean;

  billableFirewalls: string[];

  // Billable model identity for model usage_event reporting. Only set for
  // vm0-managed model provider runs; BYOK/custom providers leave it unset.
  modelUsageProvider?: string;

  // Provider-derived framework when zero-layer resolution ran. Source of
  // truth for downstream framework-aware logic (dispatch + validation).
  // Falls back to compose framework via extractCliAgentType when undefined
  // (CLI path, no provider context).
  resolvedFramework?: string;

  // API start time for E2E timing metrics — epoch millis captured at the route
  // handler's first line by the caller (see issue #9936).
  apiStartTime: number;

  // True when the run was previously enqueued and is now being dispatched from
  // the queue. Used only for telemetry (was_queued dimension on api_to_executor)
  // so latency queries can separate queue-dispatch from direct-dispatch runs.
  wasQueued?: boolean;
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
  /**
   * Stamped by the route handler right before returning HTTP 201, via
   * CreateZeroRunResult.markResponseReady(). Anchors the end of Phase-1
   * residual work (persist_run + insert_chat_message + route sync) and the
   * start of the Next.js after() scheduling gap. Absent on non-chat triggers
   * that don't participate in the marker protocol.
   */
  responseReady?: number;
  /**
   * Stamped as the first synchronous line of the Next.js after() closure,
   * before dispatchZeroRun is invoked. Isolates pure platform after()
   * scheduling (responseReady → afterEnterAt) from JS-local closure-to-
   * dispatch overhead (afterEnterAt → dispatchStart). Absent on non-chat
   * triggers (paired with responseReady and dispatchStart).
   */
  afterEnterAt?: number;
  /**
   * Stamped at the first synchronous line of dispatchZeroRun (inside the
   * after() callback). Anchors the end of the after() scheduling gap and the
   * start of Phase-2 real work (registerCallbacks + token generation).
   * Absent on non-chat triggers (paired with responseReady).
   */
  dispatchStart?: number;
  token: number;
  resolveSourceDuration?: number;
  resolveSecretsDuration?: number;
}
