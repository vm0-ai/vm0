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
import { runtimePaths } from "../paths.js";
import { withFileLock } from "../utils/file-lock.js";

const execAsync = promisify(exec);
const logger = createLogger("IPRegistry");

// ============ Constants ============

const IP_PREFIX = "172.16.0.";
const IP_START = 2;
const IP_END = 254;

// ============ Types ============

/**
 * IP allocation entry
 */
interface IPAllocation {
  runnerPid: number; // PID of the runner that created this allocation
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
  /** Registry file path (default: /var/run/vm0/ip-registry.json) */
  registryPath?: string;
  /** Function to ensure registry directory exists */
  ensureRegistryDir?: () => Promise<void>;
  /** Function to scan all TAP devices on system */
  scanTapDevices?: () => Promise<Set<string>>;
  /** Function to check if a TAP device exists */
  checkTapExists?: (tapDevice: string) => Promise<boolean>;
}

// ============ Default Functions ============

async function defaultEnsureRegistryDir(registryPath: string): Promise<void> {
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    await execAsync(`sudo mkdir -p ${dir}`);
    await execAsync(`sudo chmod 777 ${dir}`);
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

/**
 * Check if a process is running by sending signal 0
 */
function isProcessRunning(pid: number): boolean {
  // PID must be a positive integer
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but no permission → assume running
    // ESRCH = process doesn't exist → not running
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ============ IP Registry Class ============

/**
 * IP Registry class
 *
 * Manages IP address allocation with file-based persistence and locking.
 */
export class IPRegistry {
  private readonly config: Required<IPRegistryConfig>;

  constructor(config: IPRegistryConfig = {}) {
    const registryPath = config.registryPath ?? runtimePaths.ipRegistry;
    this.config = {
      registryPath,
      ensureRegistryDir:
        config.ensureRegistryDir ??
        (() => defaultEnsureRegistryDir(registryPath)),
      scanTapDevices: config.scanTapDevices ?? defaultScanTapDevices,
      checkTapExists: config.checkTapExists ?? defaultCheckTapExists,
    };
  }

  // ============ File Lock ============

  /**
   * Execute a function while holding an exclusive lock on the IP pool
   */
  private async withIPLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.config.ensureRegistryDir();

    // Ensure registry file exists (proper-lockfile requires file to exist)
    // Check first to avoid unnecessary syscall on every lock operation
    if (!fs.existsSync(this.config.registryPath)) {
      // Use 'wx' flag for atomic creation - handles race where multiple
      // processes see file missing simultaneously
      try {
        fs.writeFileSync(
          this.config.registryPath,
          JSON.stringify({ allocations: {} }, null, 2),
          { flag: "wx" },
        );
      } catch (err) {
        // EEXIST means another process created it first - that's fine
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
      }
    }

    return withFileLock(this.config.registryPath, fn);
  }

  // ============ Registry CRUD ============

  /**
   * Read the IP registry from file
   */
  private readRegistry(): IPRegistryData {
    try {
      if (fs.existsSync(this.config.registryPath)) {
        const content = fs.readFileSync(this.config.registryPath, "utf-8");
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
    fs.writeFileSync(
      this.config.registryPath,
      JSON.stringify(registry, null, 2),
    );
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

      registry.allocations[ip] = {
        runnerPid: process.pid,
        tapDevice,
        vmId: null,
      };
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
   * Clean up orphaned IP allocations
   *
   * An allocation is orphaned if:
   * 1. TAP device no longer exists on the system, OR
   * 2. Runner process that created it is no longer running
   *
   * @returns List of orphaned TAP devices that should be deleted by caller
   */
  async cleanupOrphanedIPs(): Promise<string[]> {
    // Scan TAP devices BEFORE acquiring lock to minimize lock hold time
    const activeTaps = await this.config.scanTapDevices();
    logger.log(`Found ${activeTaps.size} TAP device(s) on system`);

    return this.withIPLock(async () => {
      const registry = this.readRegistry();
      const beforeCount = Object.keys(registry.allocations).length;

      if (beforeCount === 0) {
        return [];
      }

      const cleanedRegistry: IPRegistryData = { allocations: {} };
      const orphanedTaps: string[] = [];

      for (const [ip, allocation] of Object.entries(registry.allocations)) {
        const tapInScan = activeTaps.has(allocation.tapDevice);
        const runnerAlive = isProcessRunning(allocation.runnerPid);

        // If runner is dead, allocation is orphaned (regardless of TAP status)
        if (!runnerAlive) {
          logger.log(
            `Removing orphaned IP ${ip} (runner PID ${allocation.runnerPid} not running)`,
          );
          // If TAP still exists, it's orphaned and should be deleted
          if (tapInScan) {
            orphanedTaps.push(allocation.tapDevice);
          }
          continue;
        }

        // Runner is alive, check TAP existence
        if (tapInScan) {
          // TAP exists in initial scan, keep allocation
          cleanedRegistry.allocations[ip] = allocation;
        } else {
          // TAP not in initial scan, double-check
          // (might have been created after scan, before we acquired lock)
          const exists = await this.config.checkTapExists(allocation.tapDevice);
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

      return orphanedTaps;
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
  getAllocations(): Map<
    string,
    { runnerPid: number; tapDevice: string; vmId: string | null }
  > {
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
 * @returns List of orphaned TAP devices that should be deleted by caller
 */
export async function cleanupOrphanedIPs(): Promise<string[]> {
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
  { runnerPid: number; tapDevice: string; vmId: string | null }
> {
  return getRegistry().getAllocations();
}

/**
 * Get IP allocation for a specific VM ID (for diagnostic purposes)
 */
export function getIPForVm(vmId: string): string | undefined {
  return getRegistry().getIPForVm(vmId);
}
