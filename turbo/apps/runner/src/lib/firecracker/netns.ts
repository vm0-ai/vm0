/**
 * Network Namespace Utilities
 *
 * Low-level utilities for network namespace operations.
 * Used by netns-pool.ts for pooled namespaces and snapshot command for one-off namespaces.
 */

import { execCommand } from "../utils/exec.js";

// ============ Snapshot Network Constants ============

/**
 * Fixed network configuration for snapshot VMs.
 * These values are baked into the base snapshot and must match
 * the namespace TAP device configuration.
 *
 * Since each VM runs in an isolated namespace, we can use fixed values
 * for all VMs - no conflicts possible.
 */
export const SNAPSHOT_NETWORK = {
  /** TAP device name inside namespace (must match Firecracker config) */
  tapName: "vm0-tap",
  /** Guest MAC address (locally administered, fixed for all snapshots) */
  guestMac: "02:00:00:00:00:01",
  /** Guest IP inside the VM (baked into snapshot) */
  guestIp: "192.168.241.2",
  /** Gateway IP (TAP device in namespace) */
  gatewayIp: "192.168.241.1",
  /** Netmask for /29 subnet (dotted decimal for kernel boot args) */
  netmask: "255.255.255.248",
  /** CIDR prefix length (for ip commands) */
  prefixLen: 29,
} as const;

/**
 * Generate kernel boot args for creating base snapshot.
 * Only used when creating the initial snapshot, not when restoring.
 */
export function generateSnapshotNetworkBootArgs(): string {
  const { guestIp, gatewayIp, netmask } = SNAPSHOT_NETWORK;
  return `ip=${guestIp}::${gatewayIp}:${netmask}:vm0-guest:eth0:off`;
}

/**
 * TAP device configuration
 */
interface TapConfig {
  /** TAP device name */
  tapName: string;
  /** Gateway IP address with prefix length (e.g., "192.168.241.1/29") */
  gatewayIpWithPrefix: string;
}

/**
 * Create a network namespace with TAP device
 *
 * Creates a minimal namespace suitable for running a Firecracker VM.
 * Does not set up veth pairs or iptables - use netns-pool for full connectivity.
 */
export async function createNetnsWithTap(
  nsName: string,
  tap: TapConfig,
): Promise<void> {
  // Create namespace
  await execCommand(`ip netns add ${nsName}`);

  // Create TAP device inside namespace
  await execCommand(
    `ip netns exec ${nsName} ip tuntap add ${tap.tapName} mode tap`,
  );

  // Configure TAP with gateway IP
  await execCommand(
    `ip netns exec ${nsName} ip addr add ${tap.gatewayIpWithPrefix} dev ${tap.tapName}`,
  );

  // Bring up TAP device
  await execCommand(`ip netns exec ${nsName} ip link set ${tap.tapName} up`);

  // Bring up loopback
  await execCommand(`ip netns exec ${nsName} ip link set lo up`);
}
