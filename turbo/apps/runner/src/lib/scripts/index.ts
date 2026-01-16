/**
 * Agent execution scripts (TypeScript bundled to ESM .mjs)
 * Re-exports all script constants for use by executor
 * Script content is shared with E2B service via @vm0/core
 */
export {
  RUN_AGENT_SCRIPT,
  DOWNLOAD_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  ENV_LOADER_SCRIPT,
  SCRIPT_PATHS,
} from "@vm0/core";

/**
 * Environment loader script path
 * This wrapper loads environment from JSON file before executing run-agent.mjs
 * Runner uses this because SSH doesn't support passing environment variables directly
 */
export const ENV_LOADER_PATH = "/usr/local/bin/vm0-agent/env-loader.mjs";
