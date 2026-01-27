/**
 * Agent execution scripts configuration
 *
 * Note: Script content is no longer exported here - scripts are pre-bundled
 * in the rootfs image during build. See: apps/runner/scripts/deploy/build-rootfs.sh
 *
 * Only paths are exported for runtime usage (e.g., running download script).
 */
export { SCRIPT_PATHS } from "@vm0/core";

/**
 * Environment loader script path
 * This wrapper loads environment from JSON file before executing run-agent.mjs
 * Runner uses this because remote exec doesn't support passing environment variables directly
 */
export const ENV_LOADER_PATH = "/usr/local/bin/vm0-agent/env-loader.mjs";
