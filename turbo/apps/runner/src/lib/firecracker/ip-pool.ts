/**
 * IP Pool Manager for Firecracker VMs
 *
 * Provides race-safe IP allocation using file-based locking (B) combined with
 * TAP device enumeration for self-healing (C). This ensures:
 * - No IP collisions during parallel VM creation
 * - Automatic recovery from crashes by reconciling with actual TAP devices
 *
 * IP range: 172.16.0.2 - 172.16.0.254 (253 addresses)
 * 172.16.0.1 is reserved for the bridge gateway
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execAsync = promisify(exec);

/**
 * Configuration constants
 */
const VM0_RUN_DIR = "/var/run/vm0";
const REGISTRY_FILE_PATH = path.join(VM0_RUN_DIR, "ip-registry.json");
const BRIDGE_NAME = "vm0br0";

/**
 * IP range constants
 */
const IP_PREFIX = "172.16.0.";
const IP_START = 2; // First usable IP (172.16.0.2)
const IP_END = 254; // Last usable IP (172.16.0.254)

/**
 * Lock timeout in milliseconds
 */
const LOCK_TIMEOUT_MS = 10000;
const LOCK_RETRY_INTERVAL_MS = 100;

/**
 * Grace period for new allocations (in milliseconds)
 * Entries newer than this are kept during reconciliation even if TAP doesn't exist yet.
 * This handles the window between IP allocation and TAP device creation.
 */
const ALLOCATION_GRACE_PERIOD_MS = 30000; // 30 seconds

/**
 * Registry entry for an allocated IP
 */
interface IPAllocation {
  vmId: string;
  tapDevice: string;
  allocatedAt: string;
}

/**
 * IP Registry structure
 */
interface IPRegistry {
  allocations: Record<string, IPAllocation>;
}

/**
 * Ensure the vm0 run directory exists
 */
async function ensureRunDir(): Promise<void> {
  if (!fs.existsSync(VM0_RUN_DIR)) {
    await execAsync(`sudo mkdir -p ${VM0_RUN_DIR}`);
    await execAsync(`sudo chmod 777 ${VM0_RUN_DIR}`);
  }
}

/**
 * Execute a function while holding an exclusive lock on the IP pool
 *
 * This helper provides file-based locking to prevent race conditions during
 * concurrent IP operations. It:
 * 1. Acquires an exclusive lock using atomic file creation
 * 2. Detects and cleans up stale locks from dead processes
 * 3. Executes the provided callback
 * 4. Releases the lock in a finally block
 *
 * @param fn The function to execute while holding the lock
 * @returns The result of the callback function
 * @throws Error if lock cannot be acquired within timeout
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureRunDir();

  const lockMarker = path.join(VM0_RUN_DIR, "ip-pool.lock.active");
  const startTime = Date.now();
  let lockAcquired = false;

  // Wait for lock
  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // Try to create lock file exclusively (atomic operation)
      fs.writeFileSync(lockMarker, process.pid.toString(), { flag: "wx" });
      lockAcquired = true;
      break;
    } catch {
      // Lock exists, check if it's stale (process dead)
      try {
        const pidStr = fs.readFileSync(lockMarker, "utf-8");
        const pid = parseInt(pidStr, 10);
        // Check if process is still alive
        try {
          process.kill(pid, 0);
          // Process exists, wait and retry
        } catch {
          // Process doesn't exist, remove stale lock
          fs.unlinkSync(lockMarker);
          continue;
        }
      } catch {
        // Can't read lock file, retry
      }
      await new Promise((resolve) =>
        setTimeout(resolve, LOCK_RETRY_INTERVAL_MS),
      );
    }
  }

  if (!lockAcquired) {
    throw new Error(
      `Failed to acquire IP pool lock after ${LOCK_TIMEOUT_MS}ms`,
    );
  }

  try {
    return await fn();
  } finally {
    // Release lock
    try {
      fs.unlinkSync(lockMarker);
    } catch {
      // Ignore errors on unlock
    }
  }
}

/**
 * Read the IP registry from file
 */
function readRegistry(): IPRegistry {
  try {
    if (fs.existsSync(REGISTRY_FILE_PATH)) {
      const content = fs.readFileSync(REGISTRY_FILE_PATH, "utf-8");
      return JSON.parse(content) as IPRegistry;
    }
  } catch {
    // Registry file doesn't exist or is corrupted, start fresh
  }
  return { allocations: {} };
}

/**
 * Write the IP registry to file
 */
function writeRegistry(registry: IPRegistry): void {
  fs.writeFileSync(REGISTRY_FILE_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Get all current IP allocations (for diagnostic purposes)
 *
 * This returns the current state of the IP registry without modifying it.
 * Used by the doctor command to display allocated IPs.
 *
 * @returns Map of IP addresses to their allocation info
 */
export function getAllocations(): Map<
  string,
  { vmId: string; tapDevice: string; allocatedAt: string }
> {
  const registry = readRegistry();
  return new Map(Object.entries(registry.allocations));
}

/**
 * Get IP allocation for a specific VM ID (for diagnostic purposes)
 *
 * @param vmId The VM identifier to look up
 * @returns The allocated IP or undefined if not found
 */
export function getIPForVm(vmId: string): string | undefined {
  const registry = readRegistry();
  for (const [ip, allocation] of Object.entries(registry.allocations)) {
    if (allocation.vmId === vmId) {
      return ip;
    }
  }
  return undefined;
}

/**
 * Scan TAP devices on the bridge to get actual state
 * Returns a map of TAP device names to their associated vmIds (derived from TAP name)
 */
async function scanTapDevices(): Promise<Map<string, string>> {
  const tapDevices = new Map<string, string>();

  try {
    // List all interfaces attached to the bridge
    const { stdout } = await execAsync(
      `ip link show master ${BRIDGE_NAME} 2>/dev/null || true`,
    );

    // Parse output to find TAP devices (format: "X: tapXXXXXXXX: <FLAGS>...")
    const lines = stdout.split("\n");
    for (const line of lines) {
      const match = line.match(/^\d+:\s+(tap[a-f0-9]+):/);
      if (match && match[1]) {
        const tapName = match[1];
        // Extract vmId from TAP name (tap + first 8 chars of vmId)
        const vmIdPrefix = tapName.substring(3); // Remove "tap" prefix
        tapDevices.set(tapName, vmIdPrefix);
      }
    }
  } catch {
    // Bridge doesn't exist or command failed, return empty map
  }

  return tapDevices;
}

/**
 * Reconcile the registry with actual TAP device state
 * - Remove entries for IPs whose TAP devices no longer exist
 * - This handles crash recovery where VMs were killed but registry wasn't updated
 * - Entries within the grace period are kept even if TAP doesn't exist yet
 */
function reconcileRegistry(
  registry: IPRegistry,
  activeTaps: Map<string, string>,
): IPRegistry {
  const reconciled: IPRegistry = { allocations: {} };
  const activeTapNames = new Set(activeTaps.keys());
  const now = Date.now();

  for (const [ip, allocation] of Object.entries(registry.allocations)) {
    // Check if this allocation is within the grace period
    const allocatedTime = new Date(allocation.allocatedAt).getTime();
    const isWithinGracePeriod =
      now - allocatedTime < ALLOCATION_GRACE_PERIOD_MS;

    // Keep allocation if:
    // 1. Its TAP device exists, OR
    // 2. It's within the grace period (TAP might not be created yet)
    if (activeTapNames.has(allocation.tapDevice)) {
      reconciled.allocations[ip] = allocation;
    } else if (isWithinGracePeriod) {
      // Keep recent allocation - TAP might be in process of being created
      reconciled.allocations[ip] = allocation;
    } else {
      console.log(
        `[IP Pool] Removing stale allocation for ${ip} (TAP ${allocation.tapDevice} no longer exists)`,
      );
    }
  }

  return reconciled;
}

/**
 * Find the first available IP in the range
 */
function findFreeIP(registry: IPRegistry): string | null {
  const allocatedIPs = new Set(Object.keys(registry.allocations));

  for (let octet = IP_START; octet <= IP_END; octet++) {
    const ip = `${IP_PREFIX}${octet}`;
    if (!allocatedIPs.has(ip)) {
      return ip;
    }
  }

  return null; // No free IPs available
}

/**
 * Allocate an IP address for a VM
 *
 * This is the main entry point for IP allocation. It:
 * 1. Acquires an exclusive lock to prevent race conditions
 * 2. Reads the current registry
 * 3. Scans actual TAP devices for self-healing
 * 4. Reconciles registry with actual state
 * 5. Finds and allocates a free IP
 * 6. Updates the registry
 * 7. Releases the lock
 *
 * @param vmId The VM identifier
 * @returns The allocated IP address
 * @throws Error if no free IPs are available or lock cannot be acquired
 */
export async function allocateIP(vmId: string): Promise<string> {
  // TAP device name uses first 8 chars of vmId
  const tapDevice = `tap${vmId.substring(0, 8)}`;

  return withLock(async () => {
    // Read current registry
    const registry = readRegistry();

    // Note: Reconciliation with TAP devices is intentionally NOT done during
    // allocateIP() to avoid race conditions. The reconciliation happens only
    // at runner startup via cleanupOrphanedAllocations().

    // Find a free IP
    const ip = findFreeIP(registry);
    if (!ip) {
      throw new Error(
        "No free IP addresses available in pool (172.16.0.2-254)",
      );
    }

    // Debug: log current allocation state
    const allocatedCount = Object.keys(registry.allocations).length;
    const allocatedIPs = Object.keys(registry.allocations).sort();
    console.log(
      `[IP Pool] Current state: ${allocatedCount} IPs allocated [${allocatedIPs.join(", ")}], assigning ${ip}`,
    );

    // Add allocation to registry
    registry.allocations[ip] = {
      vmId,
      tapDevice,
      allocatedAt: new Date().toISOString(),
    };

    // Write updated registry
    writeRegistry(registry);

    console.log(`[IP Pool] Allocated ${ip} for VM ${vmId} (TAP ${tapDevice})`);
    return ip;
  });
}

/**
 * Release an IP address back to the pool
 *
 * @param ip The IP address to release
 */
export async function releaseIP(ip: string): Promise<void> {
  return withLock(async () => {
    const registry = readRegistry();

    if (registry.allocations[ip]) {
      const allocation = registry.allocations[ip];
      delete registry.allocations[ip];
      writeRegistry(registry);
      console.log(
        `[IP Pool] Released ${ip} (was allocated to VM ${allocation.vmId})`,
      );
    } else {
      console.log(`[IP Pool] IP ${ip} was not in registry, nothing to release`);
    }
  });
}

/**
 * Clean up orphaned IP allocations on runner startup
 *
 * This reconciles the IP registry with actual TAP devices on the bridge.
 * It removes allocations for IPs whose TAP devices no longer exist (crashed VMs).
 *
 * IMPORTANT: This should ONLY be called at runner startup, never during
 * the allocateIP() hot path, to avoid race conditions where:
 * 1. Process A allocates IP, registry updated
 * 2. Process B calls allocateIP, scans TAPs, doesn't see A's TAP yet
 * 3. Process B reconciles and removes A's allocation
 * 4. Process B allocates the same IP -> collision!
 */
export async function cleanupOrphanedAllocations(): Promise<void> {
  return withLock(async () => {
    console.log("[IP Pool] Cleaning up orphaned allocations...");

    // Read current registry
    const registry = readRegistry();
    const beforeCount = Object.keys(registry.allocations).length;

    if (beforeCount === 0) {
      console.log("[IP Pool] No allocations in registry, nothing to clean up");
      return;
    }

    // Scan actual TAP devices on the bridge
    const activeTaps = await scanTapDevices();
    console.log(
      `[IP Pool] Found ${activeTaps.size} active TAP device(s) on bridge`,
    );

    // Reconcile registry with actual state
    const reconciled = reconcileRegistry(registry, activeTaps);
    const afterCount = Object.keys(reconciled.allocations).length;

    if (afterCount !== beforeCount) {
      writeRegistry(reconciled);
      console.log(
        `[IP Pool] Cleaned up ${beforeCount - afterCount} orphaned allocation(s)`,
      );
    } else {
      console.log("[IP Pool] No orphaned allocations found");
    }
  });
}
