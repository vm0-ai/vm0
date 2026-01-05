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

// Re-export SCRIPT_PATHS from @vm0/core - use same paths as e2b
export { SCRIPT_PATHS } from "@vm0/core";

/**
 * Environment loader script path
 * This wrapper loads environment from JSON file before executing run-agent.py
 * Runner uses this because SSH doesn't support passing environment variables directly
 */
export const ENV_LOADER_PATH = "/usr/local/bin/vm0-agent/env-loader.py";

/**
 * Environment loader script content
 * Loads environment from JSON file, then executes run-agent.py
 */
export const ENV_LOADER_SCRIPT = `#!/usr/bin/env python3
"""
Environment loader wrapper for VM0 runner.
Loads environment variables from JSON file before executing run-agent.py.

This is needed because the runner passes environment variables via SCP (JSON file)
rather than directly setting them (which E2B sandbox API supports).
"""
import os
import sys
import json

# Environment JSON file path
ENV_JSON_PATH = "/tmp/vm0-env.json"

print("[env-loader] Starting...", flush=True)

# Load environment from JSON file
if os.path.exists(ENV_JSON_PATH):
    print(f"[env-loader] Loading environment from {ENV_JSON_PATH}", flush=True)
    try:
        with open(ENV_JSON_PATH, "r") as f:
            env_data = json.load(f)
            for key, value in env_data.items():
                os.environ[key] = value
        print(f"[env-loader] Loaded {len(env_data)} environment variables", flush=True)
    except Exception as e:
        print(f"[env-loader] ERROR loading JSON: {e}", flush=True)
        sys.exit(1)
else:
    print(f"[env-loader] ERROR: Environment file not found: {ENV_JSON_PATH}", flush=True)
    sys.exit(1)

# Verify critical environment variables
critical_vars = ["VM0_RUN_ID", "VM0_API_URL", "VM0_WORKING_DIR", "VM0_PROMPT"]
for var in critical_vars:
    val = os.environ.get(var, "")
    if val:
        print(f"[env-loader] {var}={val[:50]}{'...' if len(val) > 50 else ''}", flush=True)
    else:
        print(f"[env-loader] WARNING: {var} is empty", flush=True)

# Execute run-agent.py in the same process
# Using exec to replace this process with run-agent.py
run_agent_path = "/usr/local/bin/vm0-agent/run-agent.py"
print(f"[env-loader] Executing {run_agent_path}", flush=True)

# Read and execute the script
with open(run_agent_path, "r") as f:
    code = f.read()

exec(compile(code, run_agent_path, "exec"))
`;
