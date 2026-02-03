/**
 * Overlay Pool for pre-warmed VM overlay files
 *
 * Pre-creates sparse ext4 overlay files to reduce VM boot time.
 * Instead of creating overlay files on-demand (~26ms), we acquire
 * pre-created files from a pool (~0ms).
 *
 * Design:
 * - Pool maintains a queue of pre-created overlay file paths
 * - acquire() returns a path from the pool (VM owns the file)
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
const OVERLAY_SIZE = 2 * 1024 * 1024 * 1024; // 2GB sparse file

/**
 * Pool configuration
 */
interface OverlayPoolConfig {
  /** Number of overlay files to maintain in pool */
  size: number;
  /** Start replenishing when pool drops below this count */
  replenishThreshold: number;
  /** Pool directory for overlay files */
  poolDir: string;
  /** Custom file creator function (optional, for testing) */
  createFile?: (filePath: string) => Promise<void>;
}

/**
 * Create a sparse ext4 overlay file
 */
async function createOverlayFile(filePath: string): Promise<void> {
  const fd = fs.openSync(filePath, "w");
  fs.ftruncateSync(fd, OVERLAY_SIZE);
  fs.closeSync(fd);
  await execAsync(`mkfs.ext4 -F -q "${filePath}"`);
}

/**
 * Overlay Pool class
 *
 * Manages a pool of pre-created overlay files for fast VM boot.
 */
export class OverlayPool {
  private initialized = false;
  private queue: string[] = [];
  private replenishing = false;
  private readonly config: Required<OverlayPoolConfig>;

  constructor(config: OverlayPoolConfig) {
    this.config = {
      size: config.size,
      replenishThreshold: config.replenishThreshold,
      poolDir: config.poolDir,
      createFile: config.createFile ?? createOverlayFile,
    };
  }

  /**
   * Generate unique file name using UUID
   */
  private generateFileName(): string {
    return `overlay-${randomUUID()}.ext4`;
  }

  /**
   * Scan pool directory for overlay files
   */
  private scanPoolDir(): string[] {
    if (!fs.existsSync(this.config.poolDir)) {
      return [];
    }
    return fs
      .readdirSync(this.config.poolDir)
      .filter((f) => f.startsWith("overlay-") && f.endsWith(".ext4"))
      .map((f) => path.join(this.config.poolDir, f));
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
    logger.log(`Replenishing pool: creating ${needed} overlay(s)...`);

    try {
      const promises = [];
      for (let i = 0; i < needed; i++) {
        const filePath = path.join(
          this.config.poolDir,
          this.generateFileName(),
        );
        promises.push(
          this.config.createFile(filePath).then(() => {
            this.queue.push(filePath);
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
   * Initialize the overlay pool
   */
  async init(): Promise<void> {
    this.queue = [];

    logger.log(
      `Initializing overlay pool (size=${this.config.size}, threshold=${this.config.replenishThreshold})...`,
    );

    fs.mkdirSync(this.config.poolDir, { recursive: true });

    // Clean up stale files from previous runs
    const existing = this.scanPoolDir();
    if (existing.length > 0) {
      logger.log(`Cleaning up ${existing.length} stale overlay(s)`);
      for (const file of existing) {
        fs.unlinkSync(file);
      }
    }

    this.initialized = true;
    await this.replenish();
    logger.log("Overlay pool initialized");
  }

  /**
   * Acquire an overlay file from the pool
   *
   * Returns the file path. Caller owns the file and must delete it when done.
   * Falls back to on-demand creation if pool is exhausted.
   */
  async acquire(): Promise<string> {
    if (!this.initialized) {
      throw new Error("Overlay pool not initialized");
    }

    const filePath = this.queue.shift();

    if (filePath) {
      logger.log(`Acquired overlay from pool (${this.queue.length} remaining)`);

      // Trigger background replenishment if below threshold
      if (this.queue.length < this.config.replenishThreshold) {
        this.replenish().catch((err) => {
          logger.error(
            `Background replenish failed: ${err instanceof Error ? err.message : "Unknown"}`,
          );
        });
      }

      return filePath;
    }

    // Pool exhausted - create on demand
    logger.log("Pool exhausted, creating overlay on-demand");
    const newPath = path.join(this.config.poolDir, this.generateFileName());
    await this.config.createFile(newPath);
    return newPath;
  }

  /**
   * Clean up the overlay pool
   */
  cleanup(): void {
    if (!this.initialized) {
      return;
    }

    logger.log("Cleaning up overlay pool...");

    // Delete files in queue
    for (const file of this.queue) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        logger.log(
          `Failed to delete ${file}: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      }
    }
    this.queue = [];

    // Also clean any orphaned files
    for (const file of this.scanPoolDir()) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        logger.log(
          `Failed to delete ${file}: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      }
    }

    this.initialized = false;
    this.replenishing = false;
    logger.log("Overlay pool cleaned up");
  }
}

/**
 * Global overlay pool instance
 */
let overlayPool: OverlayPool | null = null;

/**
 * Initialize the global overlay pool
 */
export async function initOverlayPool(
  config: OverlayPoolConfig,
): Promise<OverlayPool> {
  if (overlayPool) {
    overlayPool.cleanup();
  }
  overlayPool = new OverlayPool(config);
  await overlayPool.init();
  return overlayPool;
}

/**
 * Acquire an overlay file from the global pool
 * @throws Error if pool was not initialized with initOverlayPool
 */
export function acquireOverlay(): Promise<string> {
  if (!overlayPool) {
    throw new Error(
      "Overlay pool not initialized. Call initOverlayPool() first.",
    );
  }
  return overlayPool.acquire();
}

/**
 * Clean up the global overlay pool
 */
export function cleanupOverlayPool(): void {
  if (overlayPool) {
    overlayPool.cleanup();
    overlayPool = null;
  }
}
