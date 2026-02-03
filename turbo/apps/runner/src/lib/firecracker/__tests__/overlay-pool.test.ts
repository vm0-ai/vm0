import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayPool } from "../overlay-pool.js";

/**
 * Simple file creator for testing (no mkfs.ext4)
 */
async function testCreateFile(filePath: string): Promise<void> {
  fs.writeFileSync(filePath, "test-overlay");
}

describe("OverlayPool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-pool-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates pool directory and pre-warms files", async () => {
      const poolDir = path.join(tempDir, "pool");
      const pool = new OverlayPool({
        poolDir,
        size: 3,
        createFile: testCreateFile,
      });

      await pool.init();

      expect(fs.existsSync(poolDir)).toBe(true);
      const files = fs.readdirSync(poolDir);
      expect(files.length).toBe(3);
      expect(files.every((f) => f.startsWith("overlay-"))).toBe(true);
      expect(files.every((f) => f.endsWith(".ext4"))).toBe(true);

      pool.cleanup();
    });

    it("cleans up stale files from previous runs", async () => {
      const poolDir = path.join(tempDir, "pool");
      fs.mkdirSync(poolDir, { recursive: true });

      // Create stale files
      fs.writeFileSync(path.join(poolDir, "overlay-stale-1.ext4"), "stale");
      fs.writeFileSync(path.join(poolDir, "overlay-stale-2.ext4"), "stale");
      fs.writeFileSync(path.join(poolDir, "other-file.txt"), "keep");

      const pool = new OverlayPool({
        poolDir,
        size: 2,
        createFile: testCreateFile,
      });
      await pool.init();

      const files = fs.readdirSync(poolDir);
      // Should have 2 new files + 1 non-overlay file
      expect(files.filter((f) => f.startsWith("overlay-")).length).toBe(2);
      expect(files.includes("other-file.txt")).toBe(true);
      // Stale files should be gone
      expect(files.includes("overlay-stale-1.ext4")).toBe(false);
      expect(files.includes("overlay-stale-2.ext4")).toBe(false);

      pool.cleanup();
    });

    it("handles creation failures gracefully", async () => {
      const poolDir = path.join(tempDir, "pool");
      let callCount = 0;
      const failingCreateFile = async (filePath: string): Promise<void> => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Creation failed");
        }
        fs.writeFileSync(filePath, "test-overlay");
      };

      const pool = new OverlayPool({
        poolDir,
        size: 3,
        createFile: failingCreateFile,
      });

      await pool.init();

      // Should have 2 files (one failed)
      expect(pool.getAvailableCount()).toBe(2);

      pool.cleanup();
    });
  });

  describe("acquire", () => {
    it("throws if pool not initialized", async () => {
      const poolDir = path.join(tempDir, "pool");
      const pool = new OverlayPool({
        poolDir,
        size: 2,
        createFile: testCreateFile,
      });

      await expect(pool.acquire()).rejects.toThrow(
        "Overlay pool not initialized",
      );
    });

    it("returns file from pool", async () => {
      const poolDir = path.join(tempDir, "pool");
      const pool = new OverlayPool({
        poolDir,
        size: 2,
        createFile: testCreateFile,
      });
      await pool.init();

      const file1 = await pool.acquire();
      expect(file1.startsWith(poolDir)).toBe(true);
      expect(fs.existsSync(file1)).toBe(true);

      const file2 = await pool.acquire();
      expect(file2).not.toBe(file1);
      expect(fs.existsSync(file2)).toBe(true);

      pool.cleanup();
    });

    it("creates on-demand when pool exhausted", async () => {
      const poolDir = path.join(tempDir, "pool");
      const createFileSpy = vi.fn(testCreateFile);
      const pool = new OverlayPool({
        poolDir,
        size: 1,
        createFile: createFileSpy,
      });
      await pool.init();

      // Initial creation: 1 file
      expect(createFileSpy).toHaveBeenCalledTimes(1);

      // Acquire the only pre-warmed file
      const file1 = await pool.acquire();
      expect(fs.existsSync(file1)).toBe(true);

      // Pool is exhausted, should create on-demand
      const file2 = await pool.acquire();
      expect(file2).not.toBe(file1);
      expect(fs.existsSync(file2)).toBe(true);
      expect(createFileSpy).toHaveBeenCalledTimes(2);

      pool.cleanup();
    });
  });

  describe("cleanup", () => {
    it("deletes all files in pool", async () => {
      const poolDir = path.join(tempDir, "pool");
      const pool = new OverlayPool({
        poolDir,
        size: 3,
        createFile: testCreateFile,
      });
      await pool.init();

      expect(fs.readdirSync(poolDir).length).toBe(3);

      pool.cleanup();

      const remaining = fs.readdirSync(poolDir);
      expect(remaining.filter((f) => f.startsWith("overlay-")).length).toBe(0);
    });

    it("handles missing files gracefully", async () => {
      const poolDir = path.join(tempDir, "pool");
      const pool = new OverlayPool({
        poolDir,
        size: 2,
        createFile: testCreateFile,
      });
      await pool.init();

      // Delete one file externally (simulating VM cleanup)
      const files = fs.readdirSync(poolDir);
      fs.unlinkSync(path.join(poolDir, files[0]!));

      // Cleanup should not throw
      expect(() => pool.cleanup()).not.toThrow();
    });

    it("does nothing if not initialized", () => {
      const poolDir = path.join(tempDir, "pool");
      const pool = new OverlayPool({
        poolDir,
        size: 2,
        createFile: testCreateFile,
      });

      // Should not throw
      expect(() => pool.cleanup()).not.toThrow();
    });
  });

  describe("getAvailableCount", () => {
    it("returns correct count", async () => {
      const poolDir = path.join(tempDir, "pool");
      const pool = new OverlayPool({
        poolDir,
        size: 3,
        createFile: testCreateFile,
      });
      await pool.init();

      expect(pool.getAvailableCount()).toBe(3);

      await pool.acquire();
      expect(pool.getAvailableCount()).toBe(2);

      await pool.acquire();
      expect(pool.getAvailableCount()).toBe(1);

      pool.cleanup();
    });
  });
});
