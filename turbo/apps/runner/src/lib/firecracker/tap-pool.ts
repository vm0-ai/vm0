/**
 * TAP Device Pool for Firecracker VMs
 *
 * Manages pre-warmed {TAP, IP} pairs to reduce VM boot time.
 * Instead of creating TAP devices and allocating IPs on-demand,
 * we acquire pre-created pairs from a pool.
 *
 * Design:
 * - Pool maintains a queue of pre-created {TAP, IP} pairs
 * - acquire() returns a pair with dynamically set MAC
 * - release() returns the pair to the pool
 * - Pool replenishes in background when below threshold
 *
 * TAP naming: vm0{hash8}{index3} (e.g., vm078f6669b000)
 */

import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import {
  generateMacAddress,
  BRIDGE_NAME,
  BRIDGE_IP,
  BRIDGE_NETMASK,
  type VMNetworkConfig,
} from "./network.js";
import {
  allocateIP,
  releaseIP,
  cleanupOrphanedIPs,
  assignVmIdToIP,
  clearVmIdFromIP,
} from "./ip-registry.js";

const execAsync = promisify(exec);
const logger = createLogger("TapPool");

// ============ Types ============

/**
 * Pooled resource: {TAP, IP} pair
 */
interface PooledResource {
  tapDevice: string;
  guestIp: string;
}

/**
 * Pool configuration
 */
interface TapPoolConfig {
  /** Runner name for generating unique TAP prefix */
  name: string;
  /** Number of {TAP, IP} pairs to maintain in pool */
  size: number;
  /** Start replenishing when pool drops below this count */
  replenishThreshold: number;
  /** Custom TAP creator function (optional, for testing) */
  createTap?: (name: string) => Promise<void>;
  /** Custom TAP deleter function (optional, for testing) */
  deleteTap?: (name: string) => Promise<void>;
  /** Custom MAC setter function (optional, for testing) */
  setMac?: (tap: string, mac: string) => Promise<void>;
}

// ============ Helper Functions ============

/**
 * Generate TAP prefix from runner name
 * Format: vm0{hash8} = 11 chars, leaving 4 chars for index (up to 9999)
 */
function generateTapPrefix(name: string): string {
  const hash = createHash("md5").update(name).digest("hex").substring(0, 8);
  return `vm0${hash}`;
}

/**
 * Execute a shell command with sudo
 */
async function execCommand(cmd: string): Promise<string> {
  const fullCmd = `sudo ${cmd}`;
  const { stdout } = await execAsync(fullCmd);
  return stdout.trim();
}

/**
 * Default TAP device creator
 */
async function defaultCreateTap(name: string): Promise<void> {
  await execCommand(`ip tuntap add ${name} mode tap`);
  await execCommand(`ip link set ${name} master ${BRIDGE_NAME}`);
  await execCommand(`ip link set ${name} up`);
}

/**
 * Default TAP device deleter
 */
async function defaultDeleteTap(name: string): Promise<void> {
  await execCommand(`ip link delete ${name}`);
}

/**
 * Default MAC address setter
 */
async function defaultSetMac(tap: string, mac: string): Promise<void> {
  await execCommand(`ip link set dev ${tap} address ${mac}`);
}

/**
 * Clear ARP cache entry for an IP on the bridge
 */
async function clearArpEntry(ip: string): Promise<void> {
  try {
    await execCommand(`ip neigh del ${ip} dev ${BRIDGE_NAME}`);
  } catch {
    // ARP entry might not exist, that's fine
  }
}

// ============ TapPool Class ============

/**
 * TAP Pool class
 *
 * Manages a pool of pre-created {TAP, IP} pairs for fast VM boot.
 */
export class TapPool {
  private initialized = false;
  private queue: PooledResource[] = [];
  private replenishing = false;
  private nextIndex = 0;
  private readonly prefix: string;
  private readonly config: Required<TapPoolConfig>;

  constructor(config: TapPoolConfig) {
    this.prefix = generateTapPrefix(config.name);
    this.config = {
      name: config.name,
      size: config.size,
      replenishThreshold: config.replenishThreshold,
      createTap: config.createTap ?? defaultCreateTap,
      deleteTap: config.deleteTap ?? defaultDeleteTap,
      setMac: config.setMac ?? defaultSetMac,
    };
  }

  /**
   * Generate TAP device name
   * Format: {prefix}{index} (e.g., vm01a2b3c4d000)
   */
  private generateTapName(index: number): string {
    return `${this.prefix}${index.toString().padStart(3, "0")}`;
  }

  /**
   * Check if a TAP name belongs to this pool instance
   */
  private isOwnTap(name: string): boolean {
    return name.startsWith(this.prefix);
  }

  /**
   * Create a {TAP, IP} pair
   */
  private async createPair(): Promise<PooledResource> {
    const tapDevice = this.generateTapName(this.nextIndex++);

    // Create TAP device
    await this.config.createTap(tapDevice);

    // Allocate IP
    let guestIp: string;
    try {
      guestIp = await allocateIP(tapDevice);
    } catch (err) {
      // Rollback: delete TAP if IP allocation fails
      await this.config.deleteTap(tapDevice).catch(() => {});
      throw err;
    }

    return { tapDevice, guestIp };
  }

  /**
   * Replenish the pool in background
   */
  private async replenish(): Promise<void> {
    if (this.replenishing || !this.initialized) {
      return;
    }

    const needed = this.config.size - this.queue.length;
    if (needed <= 0) {
      return;
    }

    this.replenishing = true;
    logger.log(`Replenishing pool: creating up to ${needed} pair(s)...`);

    try {
      for (let i = 0; i < needed; i++) {
        // Check if pool was shutdown during replenish
        if (!this.initialized) {
          logger.log("Pool shutdown detected, stopping replenish");
          break;
        }

        // Re-check if pool still needs more pairs
        // (release() may have returned pairs during async createPair())
        if (this.queue.length >= this.config.size) {
          break;
        }

        try {
          const pair = await this.createPair();

          // Double-check initialized after async createPair()
          // to avoid pushing to a cleaned-up queue
          if (!this.initialized) {
            // Pool was shutdown while creating pair - cleanup the pair
            await releaseIP(pair.guestIp).catch(() => {});
            await this.config.deleteTap(pair.tapDevice).catch(() => {});
            logger.log("Pool shutdown detected, cleaned up in-flight pair");
            break;
          }

          this.queue.push(pair);
        } catch (err) {
          logger.error(
            `Failed to create pair: ${err instanceof Error ? err.message : "Unknown"}`,
          );
          // Continue creating remaining pairs
        }
      }
      logger.log(`Pool replenished: ${this.queue.length} available`);
    } finally {
      this.replenishing = false;
    }
  }

  /**
   * Scan for orphaned TAP devices from previous runs (matching this pool's prefix)
   */
  private async scanOrphanedTaps(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        `ip -o link show type tuntap 2>/dev/null || true`,
      );

      const orphaned: string[] = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const match = line.match(/^\d+:\s+([a-z0-9]+):/);
        if (match && match[1] && this.isOwnTap(match[1])) {
          orphaned.push(match[1]);
        }
      }
      return orphaned;
    } catch {
      return [];
    }
  }

  /**
   * Initialize the TAP pool
   */
  async init(): Promise<void> {
    this.queue = [];
    this.nextIndex = 0;

    logger.log(
      `Initializing TAP pool (size=${this.config.size}, threshold=${this.config.replenishThreshold})...`,
    );

    // Clean up orphaned TAPs from previous runs
    const orphanedTaps = await this.scanOrphanedTaps();
    if (orphanedTaps.length > 0) {
      logger.log(`Cleaning up ${orphanedTaps.length} orphaned TAP(s)`);
      for (const tap of orphanedTaps) {
        try {
          await execCommand(`ip link delete ${tap}`);
        } catch {
          // Device might already be gone
        }
      }
    }

    // Clean up orphaned IPs and get list of orphaned TAPs to delete
    const orphanedTapsFromRegistry = await cleanupOrphanedIPs();
    for (const tap of orphanedTapsFromRegistry) {
      try {
        await execCommand(`ip link delete ${tap}`);
        logger.log(`Deleted orphaned TAP ${tap} (runner dead)`);
      } catch {
        // Device might already be gone
      }
    }

    this.initialized = true;
    await this.replenish();
    logger.log("TAP pool initialized");
  }

  /**
   * Acquire a {TAP, IP} pair from the pool
   *
   * Returns VMNetworkConfig with TAP device, IP, and MAC.
   * Falls back to on-demand creation if pool is exhausted.
   */
  async acquire(vmId: string): Promise<VMNetworkConfig> {
    let resource: PooledResource;
    let fromPool: boolean;

    const pooled = this.queue.shift();
    if (pooled) {
      resource = pooled;
      fromPool = true;
      logger.log(`Acquired pair from pool (${this.queue.length} remaining)`);

      // Trigger background replenishment if below threshold
      if (this.queue.length < this.config.replenishThreshold) {
        this.replenish().catch((err) => {
          logger.error(
            `Background replenish failed: ${err instanceof Error ? err.message : "Unknown"}`,
          );
        });
      }
    } else {
      // Pool exhausted - create on demand
      logger.log("Pool exhausted, creating pair on-demand");
      resource = await this.createPair();
      fromPool = false;

      // Trigger replenish to refill the pool for future acquires
      // Only if replenishThreshold > 0 (i.e., auto-replenish is enabled)
      if (this.config.replenishThreshold > 0) {
        this.replenish().catch((err) => {
          logger.error(
            `Background replenish failed: ${err instanceof Error ? err.message : "Unknown"}`,
          );
        });
      }
    }

    // Set MAC address based on vmId
    const guestMac = generateMacAddress(vmId);
    try {
      await this.config.setMac(resource.tapDevice, guestMac);
    } catch (err) {
      // Return pair to pool or cleanup on failure
      if (fromPool) {
        this.queue.push(resource);
        logger.log(
          `Returned pair to pool after MAC set failure: ${resource.tapDevice}`,
        );
      } else {
        await releaseIP(resource.guestIp).catch(() => {});
        await this.config.deleteTap(resource.tapDevice).catch(() => {});
      }
      throw err;
    }

    // Clear any stale ARP entry
    await clearArpEntry(resource.guestIp);

    // Update registry with vmId for diagnostic purposes
    // This is non-critical - failure should not prevent VM from starting
    try {
      await assignVmIdToIP(resource.guestIp, vmId);
    } catch (err) {
      logger.error(
        `Failed to assign vmId to IP registry: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    }

    logger.log(
      `Acquired: TAP ${resource.tapDevice}, MAC ${guestMac}, IP ${resource.guestIp}`,
    );

    return {
      tapDevice: resource.tapDevice,
      guestMac,
      guestIp: resource.guestIp,
      gatewayIp: BRIDGE_IP,
      netmask: BRIDGE_NETMASK,
    };
  }

  /**
   * Release a {TAP, IP} pair back to the pool
   * @param vmId The VM ID that is releasing this pair (for registry cleanup)
   */
  async release(
    tapDevice: string,
    guestIp: string,
    vmId: string,
  ): Promise<void> {
    // Clear ARP entry
    await clearArpEntry(guestIp);

    // If pool is not initialized (e.g., during shutdown), cleanup resources
    if (!this.initialized) {
      await releaseIP(guestIp).catch(() => {});
      try {
        await this.config.deleteTap(tapDevice);
        logger.log(`Pair deleted (pool shutdown): ${tapDevice}, ${guestIp}`);
      } catch (err) {
        logger.log(
          `Failed to delete TAP ${tapDevice}: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      }
      return;
    }

    // Return pair to queue if TAP belongs to this pool
    if (this.isOwnTap(tapDevice)) {
      // Check for duplicate release (caller error, but prevent IP conflict)
      const alreadyInQueue = this.queue.some((r) => r.tapDevice === tapDevice);
      if (alreadyInQueue) {
        logger.log(
          `Pair ${tapDevice} already in pool, ignoring duplicate release`,
        );
        return;
      }

      // Push to queue BEFORE async operation to prevent race condition
      // where concurrent release() calls both pass the duplicate check
      this.queue.push({ tapDevice, guestIp });
      logger.log(
        `Pair released: ${tapDevice}, ${guestIp} (${this.queue.length} available)`,
      );

      // Clear vmId from registry since pair is returning to pool
      // Only clears if vmId matches to prevent race condition where new VM's vmId is cleared
      // This is non-critical - failure should not prevent pair from being recycled
      try {
        await clearVmIdFromIP(guestIp, vmId);
      } catch (err) {
        logger.error(
          `Failed to clear vmId from IP registry: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      }
    } else {
      // TAP from different pool, cleanup
      await releaseIP(guestIp).catch(() => {});
      try {
        await this.config.deleteTap(tapDevice);
        logger.log(`Non-pooled pair deleted: ${tapDevice}, ${guestIp}`);
      } catch (err) {
        logger.log(
          `Failed to delete non-pooled TAP ${tapDevice}: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      }
    }
  }

  /**
   * Clean up the TAP pool
   *
   * Note: This is a sync function for compatibility with process cleanup.
   * Resources are cleaned up asynchronously (fire-and-forget).
   * Any remaining resources will be cleaned up by init() on next startup.
   */
  cleanup(): void {
    if (!this.initialized) {
      return;
    }

    logger.log(`Cleaning up TAP pool (${this.queue.length} pairs)...`);

    // Release all IPs and delete all TAPs (fire-and-forget)
    for (const { tapDevice, guestIp } of this.queue) {
      releaseIP(guestIp).catch(() => {});
      this.config.deleteTap(tapDevice).catch((err) => {
        logger.log(
          `Failed to delete ${tapDevice}: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      });
    }
    this.queue = [];

    this.initialized = false;
    this.replenishing = false;
    logger.log("TAP pool cleanup initiated");
  }
}

// ============ Global TAP Pool Instance ============

let tapPool: TapPool | null = null;

/**
 * Initialize the global TAP pool
 */
export async function initTapPool(config: TapPoolConfig): Promise<TapPool> {
  if (tapPool) {
    tapPool.cleanup();
  }
  tapPool = new TapPool(config);
  await tapPool.init();
  return tapPool;
}

/**
 * Acquire a {TAP, IP} pair from the global pool
 * @throws Error if pool was not initialized with initTapPool
 */
export async function acquireTap(vmId: string): Promise<VMNetworkConfig> {
  if (!tapPool) {
    throw new Error("TAP pool not initialized. Call initTapPool() first.");
  }
  return tapPool.acquire(vmId);
}

/**
 * Release a {TAP, IP} pair back to the global pool
 * @param vmId The VM ID that is releasing this pair (for registry cleanup)
 * @throws Error if pool was not initialized with initTapPool
 */
export async function releaseTap(
  tapDevice: string,
  guestIp: string,
  vmId: string,
): Promise<void> {
  if (!tapPool) {
    throw new Error("TAP pool not initialized. Call initTapPool() first.");
  }
  return tapPool.release(tapDevice, guestIp, vmId);
}

/**
 * Clean up the global TAP pool
 */
export function cleanupTapPool(): void {
  if (tapPool) {
    tapPool.cleanup();
    tapPool = null;
  }
}
