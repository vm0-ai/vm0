/**
 * CID Pool Manager for Firecracker VMs with Vsock
 *
 * Provides race-safe CID (Context ID) allocation using file-based locking.
 * CIDs are used for vsock communication between host and guest VMs.
 *
 * CID range: 3-254 (252 addresses)
 * CID 0: Reserved (VMADDR_CID_HYPERVISOR)
 * CID 1: Reserved (VMADDR_CID_LOCAL)
 * CID 2: Reserved (VMADDR_CID_HOST) - used by guest to connect to host
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Configuration constants
 */
const VM0_RUN_DIR = "/var/run/vm0";
const REGISTRY_FILE_PATH = path.join(VM0_RUN_DIR, "cid-registry.json");

/**
 * CID range constants
 */
const CID_START = 3; // First usable CID (CID 0-2 are reserved)
const CID_END = 254; // Last usable CID

/**
 * Lock timeout in milliseconds
 */
const LOCK_TIMEOUT_MS = 10000;
const LOCK_RETRY_INTERVAL_MS = 100;

/**
 * Registry entry for an allocated CID
 */
interface CIDAllocation {
  vmId: string;
  allocatedAt: string;
}

/**
 * CID Registry structure
 */
interface CIDRegistry {
  allocations: Record<number, CIDAllocation>;
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
 * Execute a function while holding an exclusive lock on the CID pool
 *
 * @param fn The function to execute while holding the lock
 * @returns The result of the callback function
 * @throws Error if lock cannot be acquired within timeout
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureRunDir();

  const lockMarker = path.join(VM0_RUN_DIR, "cid-pool.lock.active");
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
      `Failed to acquire CID pool lock after ${LOCK_TIMEOUT_MS}ms`,
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
 * Read the CID registry from file
 */
function readRegistry(): CIDRegistry {
  try {
    if (fs.existsSync(REGISTRY_FILE_PATH)) {
      const content = fs.readFileSync(REGISTRY_FILE_PATH, "utf-8");
      return JSON.parse(content) as CIDRegistry;
    }
  } catch {
    // Registry file doesn't exist or is corrupted, start fresh
  }
  return { allocations: {} };
}

/**
 * Write the CID registry to file
 */
function writeRegistry(registry: CIDRegistry): void {
  fs.writeFileSync(REGISTRY_FILE_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Find the first available CID in the range
 */
function findFreeCID(registry: CIDRegistry): number | null {
  const allocatedCIDs = new Set(
    Object.keys(registry.allocations).map((s) => parseInt(s, 10)),
  );

  for (let cid = CID_START; cid <= CID_END; cid++) {
    if (!allocatedCIDs.has(cid)) {
      return cid;
    }
  }

  return null; // No free CIDs available
}

/**
 * Allocate a CID for a VM
 *
 * @param vmId The VM identifier
 * @returns The allocated CID
 * @throws Error if no free CIDs are available or lock cannot be acquired
 */
export async function allocateCID(vmId: string): Promise<number> {
  return withLock(async () => {
    // Read current registry
    const registry = readRegistry();

    // Find a free CID
    const cid = findFreeCID(registry);
    if (cid === null) {
      throw new Error("No free CIDs available in pool (3-254)");
    }

    // Debug: log current allocation state
    const allocatedCount = Object.keys(registry.allocations).length;
    const allocatedCIDs = Object.keys(registry.allocations)
      .map((s) => parseInt(s, 10))
      .sort((a, b) => a - b);
    console.log(
      `[CID Pool] Current state: ${allocatedCount} CIDs allocated [${allocatedCIDs.join(", ")}], assigning ${cid}`,
    );

    // Add allocation to registry
    registry.allocations[cid] = {
      vmId,
      allocatedAt: new Date().toISOString(),
    };

    // Write updated registry
    writeRegistry(registry);

    console.log(`[CID Pool] Allocated CID ${cid} for VM ${vmId}`);
    return cid;
  });
}

/**
 * Release a CID back to the pool
 *
 * @param cid The CID to release
 */
export async function releaseCID(cid: number): Promise<void> {
  return withLock(async () => {
    const registry = readRegistry();

    if (registry.allocations[cid]) {
      const allocation = registry.allocations[cid];
      delete registry.allocations[cid];
      writeRegistry(registry);
      console.log(
        `[CID Pool] Released CID ${cid} (was allocated to VM ${allocation.vmId})`,
      );
    } else {
      console.log(
        `[CID Pool] CID ${cid} was not in registry, nothing to release`,
      );
    }
  });
}
