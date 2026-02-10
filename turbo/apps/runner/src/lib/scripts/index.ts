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
  /** Agent orchestrator - handles CLI execution, events, checkpoints */
  guestAgent: "/usr/local/bin/guest-agent",
} as const;
