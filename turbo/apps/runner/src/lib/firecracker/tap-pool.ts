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

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { allocateIP, releaseIP } from "./ip-pool.js";
import {
  generateMacAddress,
  BRIDGE_NAME,
  type VMNetworkConfig,
} from "./network.js";

const execAsync = promisify(exec);
const logger = createLogger("TapPool");

/**
 * Bridge configuration (must match network.ts)
 */
const BRIDGE_IP = "172.16.0.1";
const BRIDGE_NETMASK = "255.255.255.0";

/**
 * Pool configuration
 */
interface TapPoolConfig {
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
 * Clear stale iptables rules for a specific IP
 */
async function clearStaleIptablesRulesForIP(ip: string): Promise<void> {
  try {
    const { stdout } = await execAsync(
      "sudo iptables -t nat -S PREROUTING 2>/dev/null || true",
    );
    const lines = stdout.split("\n");
    const rulesForIP = lines.filter((line) => line.includes(`-s ${ip}`));

    for (const rule of rulesForIP) {
      const deleteRule = rule.replace("-A ", "-D ");
      try {
        await execCommand(`iptables -t nat ${deleteRule}`);
      } catch {
        // Rule might already be gone
      }
    }
  } catch {
    // Ignore errors - this is defensive cleanup
  }
}

/**
 * Generate TAP device name for pool
 * Format: tappXXX (e.g., tapp000, tapp001, tapp1000)
 * Linux interface names have 15 char max, tapp + digits stays well under
 */
function generateTapName(index: number): string {
  return `tapp${index.toString().padStart(3, "0")}`;
}

/**
 * Check if a name matches pool TAP pattern
 */
function isPooledTapName(name: string): boolean {
  return /^tapp\d+$/.test(name);
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
  private readonly config: Required<TapPoolConfig>;

  constructor(config: TapPoolConfig) {
    this.config = {
      size: config.size,
      replenishThreshold: config.replenishThreshold,
      createTap: config.createTap ?? defaultCreateTap,
      deleteTap: config.deleteTap ?? defaultDeleteTap,
      setMac: config.setMac ?? defaultSetMac,
    };
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
        const tapName = generateTapName(this.nextIndex++);
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
   * Initialize the TAP pool
   */
  async init(): Promise<void> {
    this.queue = [];
    this.nextIndex = 0;

    logger.log(
      `Initializing TAP pool (size=${this.config.size}, threshold=${this.config.replenishThreshold})...`,
    );

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
    let tapDevice = this.queue.shift();
    let fromPool = false;

    if (tapDevice) {
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
      tapDevice = generateTapName(this.nextIndex++);
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

    // Clear stale iptables rules for this IP
    await clearStaleIptablesRulesForIP(guestIp);

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

    // Return TAP to queue if it's a pooled device
    if (isPooledTapName(tapDevice)) {
      this.queue.push(tapDevice);
      logger.log(
        `TAP released: ${tapDevice}, IP ${guestIp} (${this.queue.length} available)`,
      );
    } else {
      // Non-pooled TAP (e.g., from before pool was enabled), delete it
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
   * Any remaining TAPs will be cleaned up by cleanupOrphanedPooledTaps() on next startup.
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
 * Global instance management
 */
let tapPoolInstance: TapPool | null = null;

/**
 * Initialize the global TAP pool
 */
export async function initTapPool(config: TapPoolConfig): Promise<void> {
  tapPoolInstance = new TapPool(config);
  await tapPoolInstance.init();
}

/**
 * Get the global TAP pool instance
 */
function getTapPool(): TapPool {
  if (!tapPoolInstance) {
    throw new Error("TAP pool not initialized");
  }
  return tapPoolInstance;
}

/**
 * Acquire a TAP device from the global pool
 */
export async function acquireTap(vmId: string): Promise<VMNetworkConfig> {
  return getTapPool().acquire(vmId);
}

/**
 * Release a TAP device back to the global pool
 */
export async function releaseTap(
  tapDevice: string,
  guestIp: string,
): Promise<void> {
  return getTapPool().release(tapDevice, guestIp);
}

/**
 * Clean up the global TAP pool
 */
export function cleanupTapPool(): void {
  if (tapPoolInstance) {
    tapPoolInstance.cleanup();
    tapPoolInstance = null;
  }
}

/**
 * Scan for and delete orphaned pooled TAP devices from previous runs
 * Called at runner startup before pool initialization
 */
export async function cleanupOrphanedPooledTaps(): Promise<void> {
  logger.log("Scanning for orphaned pooled TAPs...");

  try {
    // List all TAP devices
    const { stdout } = await execAsync(
      `ip -o link show type tuntap 2>/dev/null || true`,
    );

    const orphaned: string[] = [];
    const lines = stdout.split("\n");
    for (const line of lines) {
      const match = line.match(/^\d+:\s+(tapp\d+):/);
      if (match && match[1]) {
        orphaned.push(match[1]);
      }
    }

    if (orphaned.length === 0) {
      logger.log("No orphaned pooled TAPs found");
      return;
    }

    logger.log(`Found ${orphaned.length} orphaned pooled TAP(s), cleaning up`);
    for (const tap of orphaned) {
      try {
        await execCommand(`ip link delete ${tap}`);
        logger.log(`Deleted orphaned TAP: ${tap}`);
      } catch {
        // Device might already be gone
      }
    }
  } catch (err) {
    logger.log(
      `Warning: Could not scan for orphaned TAPs: ${err instanceof Error ? err.message : "Unknown"}`,
    );
  }
}
