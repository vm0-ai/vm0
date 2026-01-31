/**
 * TAP Device Pool for pre-warmed VM network interfaces
 *
 * Pre-creates TAP devices attached to the bridge to reduce VM boot time.
 * Instead of creating TAP devices on-demand (~9ms), we acquire
 * pre-created devices from a pool (~2ms for MAC change + ARP flush).
 *
 * Design:
 * - Pool maintains a queue of pre-created TAP device names
 * - acquire() returns a TAP with dynamically set MAC and allocated IP
 * - release() returns the TAP to the pool (instead of deleting it)
 * - Pool replenishes in background when below threshold
 */

import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { allocateIP, releaseIP } from "./ip-pool.js";
import {
  generateMacAddress,
  BRIDGE_NAME,
  BRIDGE_IP,
  BRIDGE_NETMASK,
  type VMNetworkConfig,
} from "./network.js";

const execAsync = promisify(exec);
const logger = createLogger("TapPool");

/**
 * Pool configuration
 */
interface TapPoolConfig {
  /** Runner name for generating unique TAP prefix */
  name: string;
  /** Number of TAP devices to maintain in pool */
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

/**
 * TAP Pool class
 *
 * Manages a pool of pre-created TAP devices for fast VM boot.
 */
export class TapPool {
  private initialized = false;
  private queue: string[] = [];
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
    logger.log(`Replenishing pool: creating ${needed} TAP(s)...`);

    try {
      const promises = [];
      for (let i = 0; i < needed; i++) {
        const tapName = this.generateTapName(this.nextIndex++);
        promises.push(
          this.config.createTap(tapName).then(() => {
            this.queue.push(tapName);
          }),
        );
      }
      await Promise.all(promises);
      logger.log(`Pool replenished: ${this.queue.length} available`);
    } catch (err) {
      logger.error(
        `Replenish failed: ${err instanceof Error ? err.message : "Unknown"}`,
      );
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
        // Match TAP devices with our prefix
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
    const orphaned = await this.scanOrphanedTaps();
    if (orphaned.length > 0) {
      logger.log(`Cleaning up ${orphaned.length} orphaned TAP(s)`);
      for (const tap of orphaned) {
        try {
          await execCommand(`ip link delete ${tap}`);
        } catch {
          // Device might already be gone
        }
      }
    }

    this.initialized = true;
    await this.replenish();
    logger.log("TAP pool initialized");
  }

  /**
   * Acquire a TAP device from the pool
   *
   * Returns VMNetworkConfig with TAP device, IP, and MAC.
   * Falls back to on-demand creation if pool is exhausted.
   */
  async acquire(vmId: string): Promise<VMNetworkConfig> {
    const pooledTap = this.queue.shift();
    let tapDevice: string;
    let fromPool: boolean;

    if (pooledTap) {
      tapDevice = pooledTap;
      fromPool = true;
      logger.log(`Acquired TAP from pool (${this.queue.length} remaining)`);

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
      logger.log("Pool exhausted, creating TAP on-demand");
      tapDevice = this.generateTapName(this.nextIndex++);
      fromPool = false;
      await this.config.createTap(tapDevice);
    }

    // Allocate IP from pool
    let guestIp: string;
    try {
      guestIp = await allocateIP(vmId);
    } catch (err) {
      // Return TAP to pool or delete on-demand TAP on failure
      if (fromPool) {
        this.queue.push(tapDevice);
        logger.log(
          `Returned TAP ${tapDevice} to pool after IP allocation failure`,
        );
      } else {
        this.config.deleteTap(tapDevice).catch(() => {});
      }
      throw err;
    }

    // Set MAC address based on vmId
    const guestMac = generateMacAddress(vmId);
    try {
      await this.config.setMac(tapDevice, guestMac);
    } catch (err) {
      // Release IP and return TAP to pool or delete on failure
      await releaseIP(guestIp);
      if (fromPool) {
        this.queue.push(tapDevice);
        logger.log(`Returned TAP ${tapDevice} to pool after MAC set failure`);
      } else {
        this.config.deleteTap(tapDevice).catch(() => {});
      }
      throw err;
    }

    // Clear any stale ARP entry
    await clearArpEntry(guestIp);

    logger.log(`TAP acquired: ${tapDevice}, MAC ${guestMac}, IP ${guestIp}`);

    return {
      tapDevice,
      guestMac,
      guestIp,
      gatewayIp: BRIDGE_IP,
      netmask: BRIDGE_NETMASK,
    };
  }

  /**
   * Release a TAP device back to the pool
   */
  async release(tapDevice: string, guestIp: string): Promise<void> {
    // Release IP back to the pool
    await releaseIP(guestIp);

    // Clear ARP entry
    await clearArpEntry(guestIp);

    // If pool is not initialized (e.g., during shutdown), delete the TAP
    if (!this.initialized) {
      try {
        await this.config.deleteTap(tapDevice);
        logger.log(`TAP deleted (pool shutdown): ${tapDevice}`);
      } catch (err) {
        logger.log(
          `Failed to delete TAP ${tapDevice}: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      }
      return;
    }

    // Return TAP to queue if it belongs to this pool
    if (this.isOwnTap(tapDevice)) {
      this.queue.push(tapDevice);
      logger.log(
        `TAP released: ${tapDevice}, IP ${guestIp} (${this.queue.length} available)`,
      );
    } else {
      // TAP from different pool or before pooling was enabled, delete it
      try {
        await this.config.deleteTap(tapDevice);
        logger.log(`Non-pooled TAP deleted: ${tapDevice}`);
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
   * TAP devices are deleted asynchronously (fire-and-forget).
   * Any remaining TAPs will be cleaned up by init() on next startup.
   */
  cleanup(): void {
    if (!this.initialized) {
      return;
    }

    logger.log(`Cleaning up TAP pool (${this.queue.length} devices)...`);

    // Delete all TAPs in queue (fire-and-forget)
    for (const tap of this.queue) {
      execAsync(`sudo ip link delete ${tap}`).catch((err) => {
        logger.log(
          `Failed to delete ${tap}: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      });
    }
    this.queue = [];

    this.initialized = false;
    this.replenishing = false;
    logger.log("TAP pool cleanup initiated");
  }
}

/**
 * Global TAP pool instance
 */
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
 * Acquire a TAP device from the global pool
 * @throws Error if pool was not initialized with initTapPool
 */
export async function acquireTap(vmId: string): Promise<VMNetworkConfig> {
  if (!tapPool) {
    throw new Error("TAP pool not initialized. Call initTapPool() first.");
  }
  return tapPool.acquire(vmId);
}

/**
 * Release a TAP device back to the global pool
 * @throws Error if pool was not initialized with initTapPool
 */
export async function releaseTap(
  tapDevice: string,
  guestIp: string,
): Promise<void> {
  if (!tapPool) {
    throw new Error("TAP pool not initialized. Call initTapPool() first.");
  }
  return tapPool.release(tapDevice, guestIp);
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
