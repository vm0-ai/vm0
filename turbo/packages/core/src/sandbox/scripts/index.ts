/**
 * Agent execution scripts (JavaScript)
 * Re-exports all script constants for use by e2b-service and runner executor
 *
 * Scripts are bundled TypeScript that can be executed with Node.js.
 * The bundled scripts are self-contained and include all dependencies.
 */
export {
  RUN_AGENT_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  DOWNLOAD_SCRIPT,
  SCRIPT_PATHS,
} from "./scripts.js";
