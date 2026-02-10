/**
 * Native binary paths in the Firecracker VM
 *
 * These are statically compiled binaries for performance-critical operations.
 * Only used in Firecracker runner (not E2B).
 */
export const GUEST_BINARY_PATHS = {
  /** PID 1 init process - sets up overlayfs and spawns vsock-guest */
  guestInit: "/sbin/guest-init",
  /** Storage download - parallel downloads with streaming extraction */
  guestDownload: "/usr/local/bin/guest-download",
} as const;

/**
 * Run-agent script path
 * Main agent orchestrator that handles CLI execution, events, checkpoints.
 */
export const RUN_AGENT_PATH = "/usr/local/bin/vm0-agent/run-agent.mjs";
