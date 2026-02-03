/**
 * Centralized path management for runner
 *
 * All file system paths used by the runner should be defined here
 * to make it easy to change directory structure in the future.
 */

import path from "node:path";
import { type VmId, createVmId } from "./firecracker/vm-id.js";

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

  /** Network namespace registry for multi-runner coordination */
  netnsRegistry: path.join(VM0_RUN_DIR, "netns-registry.json"),
} as const;

/** Prefix for VM workspace directories */
const VM_WORKSPACE_PREFIX = "vm0-";

/**
 * Per-runner paths derived from config.base_dir
 * Each runner instance has its own base directory
 */
export const runnerPaths = {
  /** Base directory used for snapshot generation (baseDir + /snapshot-gen) */
  snapshotBaseDir: (baseDir: string) => path.join(baseDir, "snapshot-gen"),

  /** Overlay pool directory for pre-warmed VM overlays */
  overlayPool: (baseDir: string) => path.join(baseDir, "overlay-pool"),

  /** Workspaces directory for VM work directories */
  workspacesDir: (baseDir: string) => path.join(baseDir, "workspaces"),

  /** VM work directory */
  vmWorkDir: (baseDir: string, vmId: VmId) =>
    path.join(baseDir, "workspaces", `${VM_WORKSPACE_PREFIX}${vmId}`),

  /** Runner status file */
  statusFile: (baseDir: string) => path.join(baseDir, "status.json"),

  /** Snapshot generation work directory */
  snapshotWorkDir: (baseDir: string) =>
    path.join(baseDir, "workspaces", ".snapshot-work"),

  /** Check if a directory name is a VM workspace */
  isVmWorkspace: (dirname: string) => dirname.startsWith(VM_WORKSPACE_PREFIX),

  /** Extract vmId from workspace directory name */
  extractVmId: (dirname: string): VmId =>
    createVmId(dirname.replace(VM_WORKSPACE_PREFIX, "")),
};

/**
 * VM internal paths (within workDir)
 * These are file names inside each VM's work directory
 */
export const vmPaths = {
  /** Firecracker config file (used with --config-file) */
  config: (workDir: string) => path.join(workDir, "config.json"),

  /** Vsock directory for host-guest communication */
  vsockDir: (workDir: string) => path.join(workDir, "vsock"),

  /** Vsock UDS path for host-guest communication */
  vsock: (workDir: string) => path.join(workDir, "vsock", "vsock.sock"),

  /** Firecracker API socket (used with --api-sock) */
  apiSock: (workDir: string) => path.join(workDir, "api.sock"),

  /** Overlay filesystem for VM writes */
  overlay: (workDir: string) => path.join(workDir, "overlay.ext4"),
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
