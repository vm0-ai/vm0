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
 * Environment loader script path
 * This wrapper loads environment from JSON file before executing run-agent.mjs
 * Runner uses this because remote exec doesn't support passing environment variables directly
 */
export const ENV_LOADER_PATH = "/usr/local/bin/vm0-agent/env-loader.mjs";
