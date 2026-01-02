/**
 * Agent execution scripts (Python)
 * Re-exports all script constants for use by executor
 * These are the same scripts used by E2B service
 */
export { INIT_SCRIPT } from "./lib/__init__.py.js";
export { COMMON_SCRIPT } from "./lib/common.py.js";
export { LOG_SCRIPT } from "./lib/log.py.js";
export { HTTP_SCRIPT } from "./lib/http_client.py.js";
export { EVENTS_SCRIPT } from "./lib/events.py.js";
export { DIRECT_UPLOAD_SCRIPT } from "./lib/direct_upload.py.js";
export { DOWNLOAD_SCRIPT } from "./lib/download.py.js";
export { CHECKPOINT_SCRIPT } from "./lib/checkpoint.py.js";
export { MOCK_CLAUDE_SCRIPT } from "./lib/mock_claude.py.js";
export { METRICS_SCRIPT } from "./lib/metrics.py.js";
export { UPLOAD_TELEMETRY_SCRIPT } from "./lib/upload_telemetry.py.js";
export { PROXY_SETUP_SCRIPT } from "./lib/proxy_setup.py.js";
export { MITM_ADDON_SCRIPT } from "./lib/mitm_addon.py.js";
export { SECRET_MASKER_SCRIPT } from "./lib/secret_masker.py.js";
export { RUN_AGENT_SCRIPT } from "./run-agent.py.js";

/**
 * Script paths in the Firecracker VM
 * Using /opt/vm0-scripts to avoid conflict with /usr/local/bin/vm0-agent binary
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
