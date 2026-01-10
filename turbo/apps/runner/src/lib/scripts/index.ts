/**
 * Agent execution scripts (JavaScript)
 * Re-exports all script constants for use by executor
 * Script content is shared with E2B service via @vm0/core
 */
export {
  RUN_AGENT_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  DOWNLOAD_SCRIPT,
  SCRIPT_PATHS,
} from "@vm0/core";

/**
 * Environment loader script path
 * This wrapper loads environment from JSON file before executing run-agent.js
 * Runner uses this because SSH doesn't support passing environment variables directly
 */
export const ENV_LOADER_PATH = "/usr/local/bin/vm0-agent/env-loader.js";

/**
 * Environment loader script content
 * Loads environment from JSON file, then executes run-agent.js
 *
 * Note: This is a simple shell script wrapper that:
 * 1. Sources environment variables from JSON file using jq
 * 2. Exports them for the Node.js process
 * 3. Executes run-agent.js
 */
export const ENV_LOADER_SCRIPT = `#!/bin/bash
# Environment loader wrapper for VM0 runner.
# Loads environment variables from JSON file before executing run-agent.js.
#
# This is needed because the runner passes environment variables via SCP (JSON file)
# rather than directly setting them (which E2B sandbox API supports).

set -e

ENV_JSON_PATH="/tmp/vm0-env.json"

echo "[env-loader] Starting..."

# Load environment from JSON file using jq
if [ -f "$ENV_JSON_PATH" ]; then
    echo "[env-loader] Loading environment from $ENV_JSON_PATH"

    # Export each key-value pair from JSON
    while IFS='=' read -r key value; do
        export "$key=$value"
    done < <(jq -r 'to_entries | .[] | "\\(.key)=\\(.value)"' "$ENV_JSON_PATH")

    echo "[env-loader] Environment loaded"
else
    echo "[env-loader] ERROR: Environment file not found: $ENV_JSON_PATH"
    exit 1
fi

# Execute run-agent.js
RUN_AGENT_PATH="/usr/local/bin/vm0-agent/run-agent.js"
echo "[env-loader] Executing $RUN_AGENT_PATH"

exec node "$RUN_AGENT_PATH"
`;
