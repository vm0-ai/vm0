/**
 * Agent execution scripts (Python)
 * Re-exports all script constants for use by executor
 * Script content is shared with E2B service via @vm0/core
 */
export {
  INIT_SCRIPT,
  COMMON_SCRIPT,
  LOG_SCRIPT,
  HTTP_SCRIPT,
  EVENTS_SCRIPT,
  DIRECT_UPLOAD_SCRIPT,
  DOWNLOAD_SCRIPT,
  CHECKPOINT_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  METRICS_SCRIPT,
  UPLOAD_TELEMETRY_SCRIPT,
  PROXY_SETUP_SCRIPT,
  MITM_ADDON_SCRIPT,
  SECRET_MASKER_SCRIPT,
  RUN_AGENT_SCRIPT,
} from "@vm0/core";

/**
 * Script paths in the Firecracker VM
 * Using /opt/vm0-scripts as a dedicated directory for agent execution scripts
 */
export const SCRIPT_PATHS = {
  baseDir: "/opt/vm0-scripts",
  libDir: "/opt/vm0-scripts/lib",
  libInit: "/opt/vm0-scripts/lib/__init__.py",
  runAgent: "/opt/vm0-scripts/run-agent.py",
  common: "/opt/vm0-scripts/lib/common.py",
  log: "/opt/vm0-scripts/lib/log.py",
  httpClient: "/opt/vm0-scripts/lib/http_client.py",
  events: "/opt/vm0-scripts/lib/events.py",
  directUpload: "/opt/vm0-scripts/lib/direct_upload.py",
  download: "/opt/vm0-scripts/lib/download.py",
  checkpoint: "/opt/vm0-scripts/lib/checkpoint.py",
  mockClaude: "/opt/vm0-scripts/lib/mock_claude.py",
  metrics: "/opt/vm0-scripts/lib/metrics.py",
  uploadTelemetry: "/opt/vm0-scripts/lib/upload_telemetry.py",
  proxySetup: "/opt/vm0-scripts/lib/proxy_setup.py",
  mitmAddon: "/opt/vm0-scripts/lib/mitm_addon.py",
  secretMasker: "/opt/vm0-scripts/lib/secret_masker.py",
} as const;
