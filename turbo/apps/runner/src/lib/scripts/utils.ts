/**
 * Script Utilities
 *
 * Provides utility functions for working with VM scripts.
 */

import {
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
  SCRIPT_PATHS,
  ENV_LOADER_SCRIPT,
  ENV_LOADER_PATH,
} from "./index.js";

export interface ScriptEntry {
  content: string;
  path: string;
}

/**
 * Get all scripts that need to be uploaded to the VM
 */
export function getAllScripts(): ScriptEntry[] {
  return [
    { content: INIT_SCRIPT, path: SCRIPT_PATHS.libInit },
    { content: COMMON_SCRIPT, path: SCRIPT_PATHS.common },
    { content: LOG_SCRIPT, path: SCRIPT_PATHS.log },
    { content: HTTP_SCRIPT, path: SCRIPT_PATHS.httpClient },
    { content: EVENTS_SCRIPT, path: SCRIPT_PATHS.events },
    { content: DIRECT_UPLOAD_SCRIPT, path: SCRIPT_PATHS.directUpload },
    { content: DOWNLOAD_SCRIPT, path: SCRIPT_PATHS.download },
    { content: CHECKPOINT_SCRIPT, path: SCRIPT_PATHS.checkpoint },
    { content: MOCK_CLAUDE_SCRIPT, path: SCRIPT_PATHS.mockClaude },
    { content: METRICS_SCRIPT, path: SCRIPT_PATHS.metrics },
    { content: UPLOAD_TELEMETRY_SCRIPT, path: SCRIPT_PATHS.uploadTelemetry },
    { content: PROXY_SETUP_SCRIPT, path: SCRIPT_PATHS.proxySetup },
    { content: MITM_ADDON_SCRIPT, path: SCRIPT_PATHS.mitmAddon },
    { content: SECRET_MASKER_SCRIPT, path: SCRIPT_PATHS.secretMasker },
    { content: RUN_AGENT_SCRIPT, path: SCRIPT_PATHS.runAgent },
    // Env loader is runner-specific (loads env from JSON before executing run-agent.py)
    { content: ENV_LOADER_SCRIPT, path: ENV_LOADER_PATH },
  ];
}
