/**
 * Centralized path management for runner
 *
 * All file system paths used by the runner should be defined here
 * to make it easy to change directory structure in the future.
 */

import path from "node:path";

/**
 * Base directories
 */
export const VM0_RUN_DIR = "/var/run/vm0";
const VM0_TMP_PREFIX = "/tmp/vm0";

/**
 * Runtime state paths (/var/run/vm0/)
 * These are shared across runner instances on the same host
 */
export const paths = {
  /** Runner PID file for single-instance lock */
  runnerPid: path.join(VM0_RUN_DIR, "runner.pid"),

  /** IP pool lock file */
  ipPoolLock: path.join(VM0_RUN_DIR, "ip-pool.lock.active"),

  /** IP allocation registry */
  ipRegistry: path.join(VM0_RUN_DIR, "ip-registry.json"),
} as const;

/**
 * Per-runner data paths (config.data_dir)
 * Each runner instance has its own data directory
 */
export const dataPaths = {
  /** Overlay pool directory for pre-warmed VM overlays */
  overlayPool: (dataDir: string) => path.join(dataDir, "overlay-pool"),
};

/**
 * Temporary file paths (/tmp/vm0-*)
 * These use runId or vmId for isolation
 */
export const tempPaths = {
  /** Default proxy CA directory */
  proxyDir: `${VM0_TMP_PREFIX}-proxy`,

  /** VM registry for proxy */
  vmRegistry: `${VM0_TMP_PREFIX}-vm-registry.json`,

  /** VM work directory (fallback when not using workspaces) */
  vmWorkDir: (vmId: string) => `${VM0_TMP_PREFIX}-vm-${vmId}`,

  /** Network log file for a run */
  networkLog: (runId: string) => `${VM0_TMP_PREFIX}-network-${runId}.jsonl`,
} as const;
