/**
 * Common environment variables and utilities for VM0 agent scripts.
 * This module should be imported by other scripts.
 */
import * as fs from "fs";

// Environment variables
export const RUN_ID = process.env.VM0_RUN_ID ?? "";
export const API_URL = process.env.VM0_API_URL ?? "";
export const API_TOKEN = process.env.VM0_API_TOKEN ?? "";
export const PROMPT = process.env.VM0_PROMPT ?? "";
export const VERCEL_BYPASS = process.env.VERCEL_PROTECTION_BYPASS ?? "";
export const RESUME_SESSION_ID = process.env.VM0_RESUME_SESSION_ID ?? "";

// CLI agent type - determines which CLI to invoke (claude-code or codex)
export const CLI_AGENT_TYPE = process.env.CLI_AGENT_TYPE ?? "claude-code";

// API start time (ms since epoch) - when the API request was received (for E2E timing)
export const API_START_TIME = process.env.VM0_API_START_TIME ?? "";

// OpenAI model override - used for OpenRouter/custom endpoints with Codex
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "";

// Working directory is required - no fallback allowed
export const WORKING_DIR = process.env.VM0_WORKING_DIR ?? "";

// Artifact configuration (replaces GIT_VOLUMES and VM0_VOLUMES)
export const ARTIFACT_DRIVER = process.env.VM0_ARTIFACT_DRIVER ?? "";
export const ARTIFACT_MOUNT_PATH = process.env.VM0_ARTIFACT_MOUNT_PATH ?? "";
export const ARTIFACT_VOLUME_NAME = process.env.VM0_ARTIFACT_VOLUME_NAME ?? "";
export const ARTIFACT_VERSION_ID = process.env.VM0_ARTIFACT_VERSION_ID ?? "";

// Construct webhook endpoint URLs
export const WEBHOOK_URL = `${API_URL}/api/webhooks/agent/events`;
export const CHECKPOINT_URL = `${API_URL}/api/webhooks/agent/checkpoints`;
export const COMPLETE_URL = `${API_URL}/api/webhooks/agent/complete`;
export const HEARTBEAT_URL = `${API_URL}/api/webhooks/agent/heartbeat`;
export const TELEMETRY_URL = `${API_URL}/api/webhooks/agent/telemetry`;
export const PROXY_URL = `${API_URL}/api/webhooks/agent/proxy`;

// Direct S3 upload endpoints (webhook versions for sandbox - uses JWT auth)
export const STORAGE_PREPARE_URL = `${API_URL}/api/webhooks/agent/storages/prepare`;
export const STORAGE_COMMIT_URL = `${API_URL}/api/webhooks/agent/storages/commit`;

// Heartbeat configuration
export const HEARTBEAT_INTERVAL = 60; // seconds

// Telemetry upload configuration
export const TELEMETRY_INTERVAL = 30; // seconds

// HTTP request configuration
export const HTTP_CONNECT_TIMEOUT = 10;
export const HTTP_MAX_TIME = 30;
export const HTTP_MAX_TIME_UPLOAD = 60;
export const HTTP_MAX_RETRIES = 3;

// Variables for checkpoint (use temp files to persist across subprocesses)
export const SESSION_ID_FILE = `/tmp/vm0-session-${RUN_ID}.txt`;
export const SESSION_HISTORY_PATH_FILE = `/tmp/vm0-session-history-${RUN_ID}.txt`;

// Event error flag file - used to track if any events failed to send
export const EVENT_ERROR_FLAG = `/tmp/vm0-event-error-${RUN_ID}`;

// Log file for persistent logging (directly in /tmp with vm0- prefix)
export const SYSTEM_LOG_FILE = `/tmp/vm0-main-${RUN_ID}.log`;
export const AGENT_LOG_FILE = `/tmp/vm0-agent-${RUN_ID}.log`;

// Metrics log file for system resource metrics (JSONL format)
export const METRICS_LOG_FILE = `/tmp/vm0-metrics-${RUN_ID}.jsonl`;

// Network log file for proxy request logs (JSONL format)
export const NETWORK_LOG_FILE = `/tmp/vm0-network-${RUN_ID}.jsonl`;

// Telemetry position tracking files (to avoid duplicate uploads)
export const TELEMETRY_LOG_POS_FILE = `/tmp/vm0-telemetry-log-pos-${RUN_ID}.txt`;
export const TELEMETRY_METRICS_POS_FILE = `/tmp/vm0-telemetry-metrics-pos-${RUN_ID}.txt`;
export const TELEMETRY_NETWORK_POS_FILE = `/tmp/vm0-telemetry-network-pos-${RUN_ID}.txt`;
export const TELEMETRY_SANDBOX_OPS_POS_FILE = `/tmp/vm0-telemetry-sandbox-ops-pos-${RUN_ID}.txt`;

// Sandbox operations log file (JSONL format)
export const SANDBOX_OPS_LOG_FILE = `/tmp/vm0-sandbox-ops-${RUN_ID}.jsonl`;

// Metrics collection configuration
export const METRICS_INTERVAL = 5; // seconds

/**
 * Validate required configuration.
 * Throws Error if configuration is invalid.
 * Returns true if valid.
 */
export function validateConfig(): boolean {
  if (!WORKING_DIR) {
    throw new Error("VM0_WORKING_DIR is required but not set");
  }
  return true;
}

interface SandboxOpEntry {
  ts: string;
  action_type: string;
  duration_ms: number;
  success: boolean;
  error?: string;
}

/**
 * Record a sandbox operation to JSONL file for telemetry upload.
 *
 * @param actionType - Operation name (e.g., "init_total", "storage_download", "cli_execution")
 * @param durationMs - Duration in milliseconds
 * @param success - Whether the operation succeeded
 * @param error - Optional error message if failed
 */
export function recordSandboxOp(
  actionType: string,
  durationMs: number,
  success: boolean,
  error?: string,
): void {
  const entry: SandboxOpEntry = {
    ts: new Date().toISOString(),
    action_type: actionType,
    duration_ms: durationMs,
    success,
  };
  if (error) {
    entry.error = error;
  }

  fs.appendFileSync(SANDBOX_OPS_LOG_FILE, JSON.stringify(entry) + "\n");
}
