/**
 * Overlay Pool for pre-warmed VM overlay files
 *
 * Pre-creates sparse ext4 overlay files to reduce VM boot time.
 * Instead of creating overlay files on-demand (~26ms), we acquire
 * pre-created files from a pool (~0ms).
 *
 * Design:
 * - Pool maintains a queue of pre-created overlay file paths
 * - acquireOverlay() returns a path from the pool (VM owns the file)
 * - VM deletes the file when done
 * - Pool replenishes in background when below threshold
 */

import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";

const execAsync = promisify(exec);
const logger = createLogger("OverlayPool");

/**
 * Configuration constants
 */
const VM0_RUN_DIR = "/var/run/vm0";
const POOL_DIR = path.join(VM0_RUN_DIR, "overlay-pool");
const OVERLAY_SIZE = 2 * 1024 * 1024 * 1024; // 2GB sparse file

/**
 * Pool configuration
 */
interface OverlayPoolConfig {
  /** Number of overlay files to maintain in pool */
  size: number;
  /** Start replenishing when pool drops below this count */
  replenishThreshold: number;
}

/**
 * Pool state
 */
interface PoolState {
  initialized: boolean;
  config: OverlayPoolConfig | null;
  queue: string[];
  replenishing: boolean;
}

const poolState: PoolState = {
  initialized: false,
  config: null,
  queue: [],
  replenishing: false,
};

/**
 * Ensure the pool directory exists
 */
async function ensurePoolDir(): Promise<void> {
  if (!fs.existsSync(VM0_RUN_DIR)) {
    await execAsync(`sudo mkdir -p ${VM0_RUN_DIR}`);
    await execAsync(`sudo chmod 777 ${VM0_RUN_DIR}`);
  }
  if (!fs.existsSync(POOL_DIR)) {
    fs.mkdirSync(POOL_DIR, { recursive: true });
  }
}

/**
 * Create a single overlay file
 */
async function createOverlayFile(filePath: string): Promise<void> {
  const fd = fs.openSync(filePath, "w");
  fs.ftruncateSync(fd, OVERLAY_SIZE);
  fs.closeSync(fd);
  await execAsync(`mkfs.ext4 -F -q "${filePath}"`);
}

/**
 * Generate unique file name using UUID
 */
function generateFileName(): string {
  return `overlay-${randomUUID()}.ext4`;
}

/**
 * Scan pool directory for overlay files
 */
function scanPoolDir(): string[] {
  if (!fs.existsSync(POOL_DIR)) {
    return [];
  }
  return fs
    .readdirSync(POOL_DIR)
    .filter((f) => f.startsWith("overlay-") && f.endsWith(".ext4"))
    .map((f) => path.join(POOL_DIR, f));
}

/**
 * Replenish the pool in background
 */
async function replenishPool(): Promise<void> {
  if (poolState.replenishing || !poolState.initialized || !poolState.config) {
    return;
  }

  const needed = poolState.config.size - poolState.queue.length;
  if (needed <= 0) {
    return;
  }

  poolState.replenishing = true;
  logger.log(`Replenishing pool: creating ${needed} overlay(s)...`);

  try {
    const promises = [];
    for (let i = 0; i < needed; i++) {
      const filePath = path.join(POOL_DIR, generateFileName());
      promises.push(
        createOverlayFile(filePath).then(() => {
          poolState.queue.push(filePath);
        }),
      );
    }
    await Promise.all(promises);
    logger.log(`Pool replenished: ${poolState.queue.length} available`);
  } catch (err) {
    logger.error(
      `Replenish failed: ${err instanceof Error ? err.message : "Unknown"}`,
    );
  } finally {
    poolState.replenishing = false;
  }
}

/**
 * Initialize the overlay pool
 */
export async function initOverlayPool(
  config: OverlayPoolConfig,
): Promise<void> {
  poolState.config = config;
  poolState.queue = [];

  logger.log(
    `Initializing overlay pool (size=${config.size}, threshold=${config.replenishThreshold})...`,
  );

  await ensurePoolDir();

  // Clean up stale files from previous runs
  const existing = scanPoolDir();
  if (existing.length > 0) {
    logger.log(`Cleaning up ${existing.length} stale overlay(s)`);
    for (const file of existing) {
      fs.unlinkSync(file);
    }
  }

  poolState.initialized = true;
  await replenishPool();
  logger.log("Overlay pool initialized");
}

/**
 * Acquire an overlay file from the pool
 *
 * Returns the file path. Caller owns the file and must delete it when done.
 * Falls back to on-demand creation if pool is exhausted.
 */
export async function acquireOverlay(): Promise<string> {
  const filePath = poolState.queue.shift();

  if (filePath) {
    logger.log(
      `Acquired overlay from pool (${poolState.queue.length} remaining)`,
    );

    // Trigger background replenishment if below threshold
    if (
      poolState.config &&
      poolState.queue.length < poolState.config.replenishThreshold
    ) {
      replenishPool().catch((err) => {
        logger.error(
          `Background replenish failed: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      });
    }

    return filePath;
  }

  // Pool exhausted - create on demand
  logger.log("Pool exhausted, creating overlay on-demand");
  const newPath = path.join(POOL_DIR, generateFileName());
  await createOverlayFile(newPath);
  return newPath;
}

/**
 * Clean up the overlay pool
 */
export function cleanupOverlayPool(): void {
  if (!poolState.initialized) {
    return;
  }

  logger.log("Cleaning up overlay pool...");

  // Delete files in queue
  for (const file of poolState.queue) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      logger.log(
        `Failed to delete ${file}: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    }
  }
  poolState.queue = [];

  // Also clean any orphaned files
  for (const file of scanPoolDir()) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      logger.log(
        `Failed to delete ${file}: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    }
  }

  poolState.initialized = false;
  poolState.replenishing = false;
  logger.log("Overlay pool cleaned up");
}
