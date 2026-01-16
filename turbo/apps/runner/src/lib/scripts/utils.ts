/**
 * Script Utilities
 *
 * Provides utility functions for working with VM scripts.
 */

import {
  RUN_AGENT_SCRIPT,
  DOWNLOAD_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  ENV_LOADER_SCRIPT,
  SCRIPT_PATHS,
  ENV_LOADER_PATH,
} from "./index.js";

interface ScriptEntry {
  content: string;
  path: string;
}

/**
 * Get all scripts that need to be uploaded to the VM
 * Scripts are self-contained ESM bundles (.mjs) - no lib directory needed
 */
export function getAllScripts(): ScriptEntry[] {
  return [
    { content: RUN_AGENT_SCRIPT, path: SCRIPT_PATHS.runAgent },
    { content: DOWNLOAD_SCRIPT, path: SCRIPT_PATHS.download },
    { content: MOCK_CLAUDE_SCRIPT, path: SCRIPT_PATHS.mockClaude },
    // Env loader is runner-specific (loads env from JSON before executing run-agent.mjs)
    { content: ENV_LOADER_SCRIPT, path: ENV_LOADER_PATH },
  ];
}
