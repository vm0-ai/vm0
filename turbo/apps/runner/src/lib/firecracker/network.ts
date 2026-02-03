/**
 * Network Utilities for Firecracker VMs
 *
 * Provides prerequisite checking and utility functions for network setup.
 * The actual network configuration is handled by netns-pool.ts.
 */

import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Check if a command exists
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check prerequisites for networking
 */
export function checkNetworkPrerequisites(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for required commands
  const requiredCommands = ["ip", "iptables", "sysctl"];
  for (const cmd of requiredCommands) {
    if (!commandExists(cmd)) {
      errors.push(`Required command not found: ${cmd}`);
    }
  }

  // Check if we have root/sudo access (simplified check)
  try {
    execSync("sudo -n true 2>/dev/null", { stdio: "ignore" });
  } catch {
    errors.push(
      "Root/sudo access required for network configuration. Please run with sudo or configure sudoers.",
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Check if a port is in use (for proxy check)
 */
export async function isPortInUse(port: number): Promise<boolean> {
  try {
    await execAsync(`ss -tln | grep -q ":${port} "`);
    return true;
  } catch {
    return false;
  }
}
