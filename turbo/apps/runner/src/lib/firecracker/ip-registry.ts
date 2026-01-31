/**
 * IP Registry for Firecracker VMs
 *
 * Manages IP address allocation with file-based persistence and locking.
 * Ensures multi-runner safety through exclusive file locks.
 *
 * IP range: 172.16.0.2 - 172.16.0.254 (253 addresses)
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { createLogger } from "../logger.js";
import { VM0_RUN_DIR, runtimePaths } from "../paths.js";

const execAsync = promisify(exec);
const logger = createLogger("IPRegistry");

// ============ Constants ============

const IP_PREFIX = "172.16.0.";
const IP_START = 2;
const IP_END = 254;
const LOCK_TIMEOUT_MS = 10000;
const LOCK_RETRY_INTERVAL_MS = 100;

// ============ Types ============

/**
 * IP allocation entry
 */
interface IPAllocation {
  tapDevice: string;
  vmId: string | null; // null when pooled, set when acquired by a VM
}

/**
 * IP Registry structure
 */
interface IPRegistry {
  allocations: Record<string, IPAllocation>;
}

// ============ File Lock ============

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
 */
async function withIPLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureRunDir();

  const lockMarker = runtimePaths.ipPoolLock;
  const startTime = Date.now();
  let lockAcquired = false;

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      fs.writeFileSync(lockMarker, process.pid.toString(), { flag: "wx" });
      lockAcquired = true;
      break;
    } catch {
      try {
        const pidStr = fs.readFileSync(lockMarker, "utf-8");
        const pid = parseInt(pidStr, 10);
        try {
          process.kill(pid, 0);
        } catch {
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
    try {
      fs.unlinkSync(lockMarker);
    } catch {
      // Ignore errors on unlock
    }
  }
}

// ============ Registry CRUD ============

/**
 * Read the IP registry from file
 */
function readIPRegistry(): IPRegistry {
  try {
    if (fs.existsSync(runtimePaths.ipRegistry)) {
      const content = fs.readFileSync(runtimePaths.ipRegistry, "utf-8");
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
function writeIPRegistry(registry: IPRegistry): void {
  fs.writeFileSync(runtimePaths.ipRegistry, JSON.stringify(registry, null, 2));
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

  return null;
}

// ============ IP Allocation ============

/**
 * Allocate an IP address for a TAP device
 */
export async function allocateIP(tapDevice: string): Promise<string> {
  return withIPLock(async () => {
    const registry = readIPRegistry();
    const ip = findFreeIP(registry);

    if (!ip) {
      throw new Error(
        "No free IP addresses available in pool (172.16.0.2-254)",
      );
    }

    registry.allocations[ip] = { tapDevice, vmId: null };
    writeIPRegistry(registry);

    logger.log(`Allocated IP ${ip} for TAP ${tapDevice}`);
    return ip;
  });
}

/**
 * Release an IP address back to the pool
 */
export async function releaseIP(ip: string): Promise<void> {
  return withIPLock(async () => {
    const registry = readIPRegistry();

    if (registry.allocations[ip]) {
      const allocation = registry.allocations[ip];
      delete registry.allocations[ip];
      writeIPRegistry(registry);
      logger.log(
        `Released IP ${ip} (was allocated to TAP ${allocation.tapDevice})`,
      );
    }
  });
}

// ============ TAP Device Scanning ============

/**
 * Scan all TAP devices on the system
 * Returns a set of TAP device names that actually exist
 */
async function scanAllTapDevices(): Promise<Set<string>> {
  const tapDevices = new Set<string>();

  try {
    const { stdout } = await execAsync(
      `ip -o link show type tuntap 2>/dev/null || true`,
    );

    const lines = stdout.split("\n");
    for (const line of lines) {
      const match = line.match(/^\d+:\s+([a-z0-9]+):/);
      if (match && match[1]) {
        tapDevices.add(match[1]);
      }
    }
  } catch {
    // Command failed, return empty set
  }

  return tapDevices;
}

/**
 * Check if a TAP device exists on the system
 */
async function checkTapExists(tapDevice: string): Promise<boolean> {
  try {
    await execAsync(`ip link show ${tapDevice} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

// ============ Cleanup ============

/**
 * Clean up orphaned IP allocations (TAP devices that no longer exist on the system)
 * Scans actual TAP devices to ensure multi-runner safety
 */
export async function cleanupOrphanedIPs(): Promise<void> {
  // Scan TAP devices BEFORE acquiring lock to minimize lock hold time
  const activeTaps = await scanAllTapDevices();
  logger.log(`Found ${activeTaps.size} TAP device(s) on system`);

  return withIPLock(async () => {
    const registry = readIPRegistry();
    const beforeCount = Object.keys(registry.allocations).length;

    if (beforeCount === 0) {
      return;
    }

    const cleanedRegistry: IPRegistry = { allocations: {} };
    for (const [ip, allocation] of Object.entries(registry.allocations)) {
      if (activeTaps.has(allocation.tapDevice)) {
        cleanedRegistry.allocations[ip] = allocation;
      } else {
        // Double-check: TAP might have been created after initial scan
        // This prevents race condition where another runner creates TAP+IP
        // between scanAllTapDevices() and withIPLock()
        const exists = await checkTapExists(allocation.tapDevice);
        if (exists) {
          cleanedRegistry.allocations[ip] = allocation;
        } else {
          logger.log(
            `Removing orphaned IP ${ip} (TAP ${allocation.tapDevice} not found)`,
          );
        }
      }
    }

    const afterCount = Object.keys(cleanedRegistry.allocations).length;
    if (afterCount !== beforeCount) {
      writeIPRegistry(cleanedRegistry);
      logger.log(`Cleaned up ${beforeCount - afterCount} orphaned IP(s)`);
    }
  });
}

// ============ VM ID Tracking ============

/**
 * Assign a vmId to an IP allocation (called when VM acquires the pair)
 */
export async function assignVmIdToIP(ip: string, vmId: string): Promise<void> {
  return withIPLock(async () => {
    const registry = readIPRegistry();
    if (registry.allocations[ip]) {
      registry.allocations[ip].vmId = vmId;
      writeIPRegistry(registry);
    }
  });
}

/**
 * Clear vmId from an IP allocation (called when pair is returned to pool)
 * Only clears if the current vmId matches expectedVmId to prevent race conditions
 * where a new VM's vmId could be cleared by the previous VM's release.
 */
export async function clearVmIdFromIP(
  ip: string,
  expectedVmId: string,
): Promise<void> {
  return withIPLock(async () => {
    const registry = readIPRegistry();
    if (
      registry.allocations[ip] &&
      registry.allocations[ip].vmId === expectedVmId
    ) {
      registry.allocations[ip].vmId = null;
      writeIPRegistry(registry);
    }
  });
}

// ============ Diagnostic Functions ============

/**
 * Get all current IP allocations (for diagnostic purposes)
 * Used by the doctor command to display allocated IPs.
 */
export function getAllocations(): Map<
  string,
  { tapDevice: string; vmId: string | null }
> {
  const registry = readIPRegistry();
  return new Map(Object.entries(registry.allocations));
}

/**
 * Get IP allocation for a specific VM ID (for diagnostic purposes)
 */
export function getIPForVm(vmId: string): string | undefined {
  const registry = readIPRegistry();
  for (const [ip, allocation] of Object.entries(registry.allocations)) {
    if (allocation.vmId === vmId) {
      return ip;
    }
  }
  return undefined;
}
