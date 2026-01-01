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
 * Same paths as E2B for consistency
 */
export const SCRIPT_PATHS = {
  baseDir: "/usr/local/bin/vm0-agent",
  libDir: "/usr/local/bin/vm0-agent/lib",
  libInit: "/usr/local/bin/vm0-agent/lib/__init__.py",
  runAgent: "/usr/local/bin/vm0-agent/run-agent.py",
  common: "/usr/local/bin/vm0-agent/lib/common.py",
  log: "/usr/local/bin/vm0-agent/lib/log.py",
  httpClient: "/usr/local/bin/vm0-agent/lib/http_client.py",
  events: "/usr/local/bin/vm0-agent/lib/events.py",
  directUpload: "/usr/local/bin/vm0-agent/lib/direct_upload.py",
  download: "/usr/local/bin/vm0-agent/lib/download.py",
  checkpoint: "/usr/local/bin/vm0-agent/lib/checkpoint.py",
  mockClaude: "/usr/local/bin/vm0-agent/lib/mock_claude.py",
  metrics: "/usr/local/bin/vm0-agent/lib/metrics.py",
  uploadTelemetry: "/usr/local/bin/vm0-agent/lib/upload_telemetry.py",
  proxySetup: "/usr/local/bin/vm0-agent/lib/proxy_setup.py",
  mitmAddon: "/usr/local/bin/vm0-agent/lib/mitm_addon.py",
  secretMasker: "/usr/local/bin/vm0-agent/lib/secret_masker.py",
} as const;
