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
const VM0_RUN_DIR = "/var/run/vm0";
const VM0_TMP_PREFIX = "/tmp/vm0";

/**
 * Runtime state paths (/var/run/vm0/)
 * These are shared across runner instances on the same host
 */
export const runtimePaths = {
  /** Runner PID file for single-instance lock */
  runnerPid: path.join(VM0_RUN_DIR, "runner.pid"),

  /** IP allocation registry */
  ipRegistry: path.join(VM0_RUN_DIR, "ip-registry.json"),
} as const;

/** Prefix for VM workspace directories */
const VM_WORKSPACE_PREFIX = "vm0-";

/**
 * Per-runner paths derived from config.base_dir
 * Each runner instance has its own base directory
 */
export const runnerPaths = {
  /** Overlay pool directory for pre-warmed VM overlays */
  overlayPool: (baseDir: string) => path.join(baseDir, "overlay-pool"),

  /** Workspaces directory for VM work directories */
  workspacesDir: (baseDir: string) => path.join(baseDir, "workspaces"),

  /** VM work directory */
  vmWorkDir: (baseDir: string, vmId: string) =>
    path.join(baseDir, "workspaces", `${VM_WORKSPACE_PREFIX}${vmId}`),

  /** Runner status file */
  statusFile: (baseDir: string) => path.join(baseDir, "status.json"),

  /** Check if a directory name is a VM workspace */
  isVmWorkspace: (dirname: string) => dirname.startsWith(VM_WORKSPACE_PREFIX),

  /** Extract vmId from workspace directory name */
  extractVmId: (dirname: string) => dirname.replace(VM_WORKSPACE_PREFIX, ""),
};

/**
 * Temporary file paths (/tmp/vm0-*)
 * These use runId for isolation
 */
export const tempPaths = {
  /** Default proxy CA directory */
  proxyDir: `${VM0_TMP_PREFIX}-proxy`,

  /** VM registry for proxy */
  vmRegistry: `${VM0_TMP_PREFIX}-vm-registry.json`,

  /** Network log file for a run */
  networkLog: (runId: string) => `${VM0_TMP_PREFIX}-network-${runId}.jsonl`,
} as const;
