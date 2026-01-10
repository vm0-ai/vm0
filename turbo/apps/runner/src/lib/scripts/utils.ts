/**
 * Script Utilities
 *
 * Provides utility functions for working with VM scripts.
 */

import {
  RUN_AGENT_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  DOWNLOAD_SCRIPT,
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
 * Scripts are bundled JavaScript files that run on Node.js
 */
export function getAllScripts(): ScriptEntry[] {
  return [
    { content: RUN_AGENT_SCRIPT, path: SCRIPT_PATHS.runAgent },
    { content: MOCK_CLAUDE_SCRIPT, path: SCRIPT_PATHS.mockClaude },
    { content: DOWNLOAD_SCRIPT, path: SCRIPT_PATHS.download },
    // Env loader is runner-specific (loads env from JSON before executing run-agent.js)
    { content: ENV_LOADER_SCRIPT, path: ENV_LOADER_PATH },
  ];
}
