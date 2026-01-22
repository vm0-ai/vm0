/**
 * Guest Client Factory
 *
 * Factory function to create the appropriate guest client (Vsock or SSH)
 * based on VM configuration and availability.
 */

import type { FirecrackerVM } from "./vm.js";
import type { GuestClient } from "./guest-client.js";
import { VsockClient } from "./vsock-client.js";
import { SSHClient, getRunnerSSHKeyPath } from "./guest.js";

/**
 * Create a guest client for the given VM
 *
 * Prefers vsock if configured, falls back to SSH.
 * This allows for gradual migration from SSH to vsock.
 *
 * @param vm - The Firecracker VM instance
 * @returns A GuestClient (either VsockClient or SSHClient)
 */
export function createGuestClient(vm: FirecrackerVM): GuestClient {
  const vsockPath = vm.getVsockPath();
  const vsockCid = vm.getVsockCid();

  // Prefer vsock if both path and CID are available
  if (vsockPath && vsockCid !== null) {
    console.log(
      `[GuestFactory] Creating VsockClient for CID ${vsockCid} at ${vsockPath}`,
    );
    return new VsockClient(vsockPath, vsockCid);
  }

  // Fall back to SSH
  const guestIp = vm.getGuestIp();
  if (!guestIp) {
    throw new Error("Cannot create guest client: no vsock and no guest IP");
  }

  const privateKeyPath = getRunnerSSHKeyPath();
  console.log(`[GuestFactory] Creating SSHClient for ${guestIp}`);

  return new SSHClient({
    host: guestIp,
    user: "user",
    privateKeyPath: privateKeyPath || undefined,
  });
}

/**
 * Check if vsock is available for the given VM
 *
 * @param vm - The Firecracker VM instance
 * @returns true if vsock is configured, false otherwise
 */
export function isVsockAvailable(vm: FirecrackerVM): boolean {
  return vm.getVsockPath() !== null && vm.getVsockCid() !== null;
}
