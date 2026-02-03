/**
 * Overlay Pool for pre-warmed VM overlay files
 *
 * Pre-creates sparse ext4 overlay files to reduce VM boot time.
 * Instead of creating overlay files on-demand (~26ms), we acquire
 * pre-created files from a pool (~0ms).
 *
 * Design:
 * - Pool creates fixed number of overlays at init (parallel)
 * - acquire() returns a path from the pool (VM owns the file)
 * - VM deletes the file when done
 * - Falls back to on-demand creation if pool is exhausted
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
  /** Number of overlay files to pre-create */
  size: number;
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
  private readonly config: Required<OverlayPoolConfig>;

  constructor(config: OverlayPoolConfig) {
    this.config = {
      size: config.size,
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
   * Ensure the pool directory exists
   */
  private async ensurePoolDir(): Promise<void> {
    const parentDir = path.dirname(this.config.poolDir);
    if (!fs.existsSync(parentDir)) {
      await execAsync(`sudo mkdir -p ${parentDir}`);
      await execAsync(`sudo chmod 777 ${parentDir}`);
    }
    if (!fs.existsSync(this.config.poolDir)) {
      fs.mkdirSync(this.config.poolDir, { recursive: true });
    }
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
   * Initialize the overlay pool
   */
  async init(): Promise<void> {
    this.queue = [];

    logger.log(`Initializing overlay pool (size=${this.config.size})...`);

    await this.ensurePoolDir();

    // Clean up stale files from previous runs
    const existing = this.scanPoolDir();
    if (existing.length > 0) {
      logger.log(`Cleaning up ${existing.length} stale overlay(s)`);
      for (const file of existing) {
        fs.unlinkSync(file);
      }
    }

    this.initialized = true;

    // Create all overlays in parallel
    if (this.config.size > 0) {
      const results = await Promise.all(
        Array.from({ length: this.config.size }, async () => {
          const filePath = path.join(
            this.config.poolDir,
            this.generateFileName(),
          );
          try {
            await this.config.createFile(filePath);
            return filePath;
          } catch (err) {
            logger.error(
              `Failed to create overlay: ${err instanceof Error ? err.message : "Unknown"}`,
            );
            return null;
          }
        }),
      );
      this.queue = results.filter((f): f is string => f !== null);
    }

    logger.log(`Overlay pool initialized: ${this.queue.length} available`);
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
      return filePath;
    }

    // Pool exhausted - create on demand
    logger.log("Pool exhausted, creating overlay on-demand");
    const newPath = path.join(this.config.poolDir, this.generateFileName());
    await this.config.createFile(newPath);
    return newPath;
  }

  /**
   * Get the number of available overlays in the pool
   */
  getAvailableCount(): number {
    return this.queue.length;
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
