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
import path from "node:path";
import { createLogger } from "../logger.js";
import { VM0_RUN_DIR } from "../paths.js";

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
interface IPRegistryData {
  allocations: Record<string, IPAllocation>;
}

/**
 * IP Registry configuration
 */
export interface IPRegistryConfig {
  /** Runtime directory (default: /var/run/vm0) */
  runDir?: string;
  /** Lock file path (default: runDir/ip-pool.lock.active) */
  lockPath?: string;
  /** Registry file path (default: runDir/ip-registry.json) */
  registryPath?: string;
  /** Function to ensure run directory exists */
  ensureRunDir?: () => Promise<void>;
  /** Function to scan all TAP devices on system */
  scanTapDevices?: () => Promise<Set<string>>;
  /** Function to check if a TAP device exists */
  checkTapExists?: (tapDevice: string) => Promise<boolean>;
}

// ============ Default Functions ============

async function defaultEnsureRunDir(runDir: string): Promise<void> {
  if (!fs.existsSync(runDir)) {
    await execAsync(`sudo mkdir -p ${runDir}`);
    await execAsync(`sudo chmod 777 ${runDir}`);
  }
}

async function defaultScanTapDevices(): Promise<Set<string>> {
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

async function defaultCheckTapExists(tapDevice: string): Promise<boolean> {
  try {
    await execAsync(`ip link show ${tapDevice} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

// ============ IP Registry Class ============

/**
 * IP Registry class
 *
 * Manages IP address allocation with file-based persistence and locking.
 */
export class IPRegistry {
  private readonly runDir: string;
  private readonly lockPath: string;
  private readonly registryPath: string;
  private readonly ensureRunDirFn: () => Promise<void>;
  private readonly scanTapDevicesFn: () => Promise<Set<string>>;
  private readonly checkTapExistsFn: (tapDevice: string) => Promise<boolean>;

  constructor(config: IPRegistryConfig = {}) {
    this.runDir = config.runDir ?? VM0_RUN_DIR;
    this.lockPath =
      config.lockPath ?? path.join(this.runDir, "ip-pool.lock.active");
    this.registryPath =
      config.registryPath ?? path.join(this.runDir, "ip-registry.json");
    this.ensureRunDirFn =
      config.ensureRunDir ?? (() => defaultEnsureRunDir(this.runDir));
    this.scanTapDevicesFn = config.scanTapDevices ?? defaultScanTapDevices;
    this.checkTapExistsFn = config.checkTapExists ?? defaultCheckTapExists;
  }

  // ============ File Lock ============

  /**
   * Execute a function while holding an exclusive lock on the IP pool
   */
  private async withIPLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureRunDirFn();

    const startTime = Date.now();
    let lockAcquired = false;

    while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
      try {
        fs.writeFileSync(this.lockPath, process.pid.toString(), { flag: "wx" });
        lockAcquired = true;
        break;
      } catch {
        try {
          const pidStr = fs.readFileSync(this.lockPath, "utf-8");
          const pid = parseInt(pidStr, 10);
          try {
            process.kill(pid, 0);
          } catch {
            fs.unlinkSync(this.lockPath);
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
        fs.unlinkSync(this.lockPath);
      } catch {
        // Ignore errors on unlock
      }
    }
  }

  // ============ Registry CRUD ============

  /**
   * Read the IP registry from file
   */
  private readRegistry(): IPRegistryData {
    try {
      if (fs.existsSync(this.registryPath)) {
        const content = fs.readFileSync(this.registryPath, "utf-8");
        return JSON.parse(content) as IPRegistryData;
      }
    } catch {
      // Registry file doesn't exist or is corrupted, start fresh
    }
    return { allocations: {} };
  }

  /**
   * Write the IP registry to file
   */
  private writeRegistry(registry: IPRegistryData): void {
    fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2));
  }

  /**
   * Find the first available IP in the range
   */
  private findFreeIP(registry: IPRegistryData): string | null {
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
  async allocateIP(tapDevice: string): Promise<string> {
    return this.withIPLock(async () => {
      const registry = this.readRegistry();
      const ip = this.findFreeIP(registry);

      if (!ip) {
        throw new Error(
          "No free IP addresses available in pool (172.16.0.2-254)",
        );
      }

      registry.allocations[ip] = { tapDevice, vmId: null };
      this.writeRegistry(registry);

      logger.log(`Allocated IP ${ip} for TAP ${tapDevice}`);
      return ip;
    });
  }

  /**
   * Release an IP address back to the pool
   */
  async releaseIP(ip: string): Promise<void> {
    return this.withIPLock(async () => {
      const registry = this.readRegistry();

      if (registry.allocations[ip]) {
        const allocation = registry.allocations[ip];
        delete registry.allocations[ip];
        this.writeRegistry(registry);
        logger.log(
          `Released IP ${ip} (was allocated to TAP ${allocation.tapDevice})`,
        );
      }
    });
  }

  // ============ Cleanup ============

  /**
   * Clean up orphaned IP allocations (TAP devices that no longer exist on the system)
   * Scans actual TAP devices to ensure multi-runner safety
   */
  async cleanupOrphanedIPs(): Promise<void> {
    // Scan TAP devices BEFORE acquiring lock to minimize lock hold time
    const activeTaps = await this.scanTapDevicesFn();
    logger.log(`Found ${activeTaps.size} TAP device(s) on system`);

    return this.withIPLock(async () => {
      const registry = this.readRegistry();
      const beforeCount = Object.keys(registry.allocations).length;

      if (beforeCount === 0) {
        return;
      }

      const cleanedRegistry: IPRegistryData = { allocations: {} };
      for (const [ip, allocation] of Object.entries(registry.allocations)) {
        if (activeTaps.has(allocation.tapDevice)) {
          cleanedRegistry.allocations[ip] = allocation;
        } else {
          // Double-check: TAP might have been created after initial scan
          // This prevents race condition where another runner creates TAP+IP
          // between scanTapDevices() and withIPLock()
          const exists = await this.checkTapExistsFn(allocation.tapDevice);
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
        this.writeRegistry(cleanedRegistry);
        logger.log(`Cleaned up ${beforeCount - afterCount} orphaned IP(s)`);
      }
    });
  }

  // ============ VM ID Tracking ============

  /**
   * Assign a vmId to an IP allocation (called when VM acquires the pair)
   */
  async assignVmIdToIP(ip: string, vmId: string): Promise<void> {
    return this.withIPLock(async () => {
      const registry = this.readRegistry();
      if (registry.allocations[ip]) {
        registry.allocations[ip].vmId = vmId;
        this.writeRegistry(registry);
      }
    });
  }

  /**
   * Clear vmId from an IP allocation (called when pair is returned to pool)
   * Only clears if the current vmId matches expectedVmId to prevent race conditions
   * where a new VM's vmId could be cleared by the previous VM's release.
   */
  async clearVmIdFromIP(ip: string, expectedVmId: string): Promise<void> {
    return this.withIPLock(async () => {
      const registry = this.readRegistry();
      if (
        registry.allocations[ip] &&
        registry.allocations[ip].vmId === expectedVmId
      ) {
        registry.allocations[ip].vmId = null;
        this.writeRegistry(registry);
      }
    });
  }

  // ============ Diagnostic Functions ============

  /**
   * Get all current IP allocations (for diagnostic purposes)
   * Used by the doctor command to display allocated IPs.
   */
  getAllocations(): Map<string, { tapDevice: string; vmId: string | null }> {
    const registry = this.readRegistry();
    return new Map(Object.entries(registry.allocations));
  }

  /**
   * Get IP allocation for a specific VM ID (for diagnostic purposes)
   */
  getIPForVm(vmId: string): string | undefined {
    const registry = this.readRegistry();
    for (const [ip, allocation] of Object.entries(registry.allocations)) {
      if (allocation.vmId === vmId) {
        return ip;
      }
    }
    return undefined;
  }
}

// ============ Global Instance ============

let globalRegistry: IPRegistry | null = null;

function getRegistry(): IPRegistry {
  if (!globalRegistry) {
    globalRegistry = new IPRegistry();
  }
  return globalRegistry;
}

/**
 * Initialize the global IP registry with custom config
 */
export function initIPRegistry(config: IPRegistryConfig = {}): IPRegistry {
  globalRegistry = new IPRegistry(config);
  return globalRegistry;
}

/**
 * Reset the global IP registry (for testing)
 */
export function resetIPRegistry(): void {
  globalRegistry = null;
}

// ============ Module-level Functions ============

/**
 * Allocate an IP address for a TAP device
 */
export async function allocateIP(tapDevice: string): Promise<string> {
  return getRegistry().allocateIP(tapDevice);
}

/**
 * Release an IP address back to the pool
 */
export async function releaseIP(ip: string): Promise<void> {
  return getRegistry().releaseIP(ip);
}

/**
 * Clean up orphaned IP allocations
 */
export async function cleanupOrphanedIPs(): Promise<void> {
  return getRegistry().cleanupOrphanedIPs();
}

/**
 * Assign a vmId to an IP allocation
 */
export async function assignVmIdToIP(ip: string, vmId: string): Promise<void> {
  return getRegistry().assignVmIdToIP(ip, vmId);
}

/**
 * Clear vmId from an IP allocation
 */
export async function clearVmIdFromIP(
  ip: string,
  expectedVmId: string,
): Promise<void> {
  return getRegistry().clearVmIdFromIP(ip, expectedVmId);
}

/**
 * Get all current IP allocations (for diagnostic purposes)
 */
export function getAllocations(): Map<
  string,
  { tapDevice: string; vmId: string | null }
> {
  return getRegistry().getAllocations();
}

/**
 * Get IP allocation for a specific VM ID (for diagnostic purposes)
 */
export function getIPForVm(vmId: string): string | undefined {
  return getRegistry().getIPForVm(vmId);
}
