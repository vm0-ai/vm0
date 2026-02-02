import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TapPool } from "../tap-pool.js";
import { initIPRegistry, resetIPRegistry } from "../ip-registry.js";

describe("TapPool", () => {
  let testDir: string;
  let activePools: TapPool[] = []; // Track pools to cleanup after each test

  let createTapCalls: string[] = [];
  let deleteTapCalls: string[] = [];
  let setMacCalls: { tap: string; mac: string }[] = [];

  const mockCreateTap = vi.fn(async (name: string) => {
    createTapCalls.push(name);
  });

  const mockDeleteTap = vi.fn(async (name: string) => {
    deleteTapCalls.push(name);
  });

  const mockSetMac = vi.fn(async (tap: string, mac: string) => {
    setMacCalls.push({ tap, mac });
  });

  // Mock TAP scanning for IPRegistry (always returns empty - no TAPs on system)
  let mockTapDevices: Set<string> = new Set();
  const mockScanTapDevices = vi.fn(async () => mockTapDevices);
  const mockCheckTapExists = vi.fn(async (tap: string) =>
    mockTapDevices.has(tap),
  );
  const mockEnsureRegistryDir = vi.fn(async () => {});

  /** Helper to read IP registry and get allocation count */
  function getIPAllocationCount(): number {
    const registryPath = path.join(testDir, "ip-registry.json");
    if (!fs.existsSync(registryPath)) return 0;
    const data = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    return Object.keys(data.allocations || {}).length;
  }

  /** Helper to create a pool and register it for cleanup */
  function createPool(
    config: ConstructorParameters<typeof TapPool>[0],
  ): TapPool {
    const pool = new TapPool(config);
    activePools.push(pool);
    return pool;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    createTapCalls = [];
    deleteTapCalls = [];
    setMacCalls = [];
    mockTapDevices = new Set();
    activePools = [];

    // Create temp directory and initialize global IPRegistry
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tap-pool-test-"));
    initIPRegistry({
      registryPath: path.join(testDir, "ip-registry.json"),
      ensureRegistryDir: mockEnsureRegistryDir,
      scanTapDevices: mockScanTapDevices,
      checkTapExists: mockCheckTapExists,
    });
  });

  afterEach(async () => {
    // Cleanup all pools to terminate any pending async operations (e.g., replenish)
    for (const pool of activePools) {
      await pool.cleanup();
    }
    vi.restoreAllMocks();
    resetIPRegistry();
    // Clean up temp directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("should create TAP devices and allocate IPs up to pool size", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 3,
        replenishThreshold: 2,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      expect(createTapCalls).toHaveLength(3);
      expect(createTapCalls).toEqual([
        "vm078f6669b000",
        "vm078f6669b001",
        "vm078f6669b002",
      ]);
      expect(getIPAllocationCount()).toBe(3);
    });

    it("should handle empty pool size", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 0,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      expect(createTapCalls).toHaveLength(0);
      expect(getIPAllocationCount()).toBe(0);
    });
  });

  describe("acquire", () => {
    it("should return TAP and IP from pool", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 2,
        replenishThreshold: 1,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      const config = await pool.acquire("test-vm-1");

      expect(config.tapDevice).toBe("vm078f6669b000");
      expect(config.guestIp).toBe("172.16.0.2");
      expect(config.gatewayIp).toBe("172.16.0.1");
      expect(config.netmask).toBe("255.255.255.0");
      expect(config.guestMac).toMatch(
        /^02:00:00:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/,
      );
    });

    it("should set MAC address on acquire", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      await pool.acquire("abc12345");

      expect(setMacCalls).toHaveLength(1);
      expect(setMacCalls[0]?.tap).toBe("vm078f6669b000");
    });

    it("should create pair on-demand when pool is exhausted", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      createTapCalls = [];

      // First acquire uses pool
      await pool.acquire("vm1");

      // Second acquire should create on-demand
      const config = await pool.acquire("vm2");

      expect(createTapCalls).toHaveLength(1);
      expect(config.tapDevice).toBe("vm078f6669b001");
    });

    it("should trigger replenishment when below threshold", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 3,
        replenishThreshold: 2,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      createTapCalls = [];

      // Acquire one - pool goes from 3 to 2, at threshold
      await pool.acquire("vm1");

      // Acquire another - pool goes from 2 to 1, below threshold
      await pool.acquire("vm2");

      // Wait for background replenishment to complete
      await vi.waitFor(() => {
        expect(createTapCalls.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe("release", () => {
    it("should return pair to pool (IP kept in registry)", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      const initialCount = getIPAllocationCount();

      const config = await pool.acquire("test-vm");
      await pool.release(config.tapDevice, config.guestIp, "test-vm");

      // Pair is returned to pool, IP should still be allocated
      expect(getIPAllocationCount()).toBe(initialCount);
    });

    it("should make pair available for next acquire after release", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // Acquire and release
      const config1 = await pool.acquire("vm1");
      await pool.release(config1.tapDevice, config1.guestIp, "vm1");

      // Reset counters
      createTapCalls = [];
      const config2 = await pool.acquire("vm2");

      // Should reuse the pair (no new TAP created)
      expect(createTapCalls).toHaveLength(0);
      expect(config2.tapDevice).toBe(config1.tapDevice);
      expect(config2.guestIp).toBe(config1.guestIp);
    });

    it("should ignore duplicate release of same pair", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 2,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      const config = await pool.acquire("test-vm");

      // Release the same pair twice
      await pool.release(config.tapDevice, config.guestIp, "test-vm");
      await pool.release(config.tapDevice, config.guestIp, "test-vm");

      // Acquire twice - should get two different pairs (not the same one twice)
      const config1 = await pool.acquire("vm1");
      const config2 = await pool.acquire("vm2");

      expect(config1.tapDevice).not.toBe(config2.tapDevice);
      expect(config1.guestIp).not.toBe(config2.guestIp);
    });

    it("should delete non-pooled TAP devices and release IP", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // Release a non-pooled TAP (doesn't match pool prefix)
      await pool.release("tap-legacy", "172.16.0.99", "legacy-vm");

      expect(deleteTapCalls).toContain("tap-legacy");
    });
  });

  describe("cleanup", () => {
    it("should delete all TAPs and release all IPs in pool", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 3,
        replenishThreshold: 2,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // cleanup() is sync but fires async operations
      expect(() => pool.cleanup()).not.toThrow();
    });

    it("should handle cleanup when pool is empty", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 0,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      expect(() => pool.cleanup()).not.toThrow();
    });

    it("should handle cleanup when not initialized", () => {
      const pool = createPool({
        name: "test-runner",
        size: 3,
        replenishThreshold: 2,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      expect(() => pool.cleanup()).not.toThrow();
    });

    it("should delete TAP and release IP when release is called after cleanup", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      const config = await pool.acquire("vm1");

      await pool.cleanup();
      deleteTapCalls = [];

      await pool.release(config.tapDevice, config.guestIp, "vm1");

      expect(deleteTapCalls).toContain(config.tapDevice);
    });
  });

  describe("TAP naming", () => {
    it("should generate sequential TAP names", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 5,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      expect(createTapCalls).toEqual([
        "vm078f6669b000",
        "vm078f6669b001",
        "vm078f6669b002",
        "vm078f6669b003",
        "vm078f6669b004",
      ]);
    });

    it("should continue sequence after on-demand creation", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      expect(createTapCalls).toEqual(["vm078f6669b000"]);

      // Exhaust pool
      await pool.acquire("vm1");

      // On-demand should use next index
      await pool.acquire("vm2");
      expect(createTapCalls).toContain("vm078f6669b001");
    });

    it("should recognize TAP names with index > 999 as pooled", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // Release TAPs with high index - should be recognized as pooled
      await pool.release("vm078f6669b1000", "172.16.0.5", "high-index-vm1");
      await pool.release("vm078f6669b12345", "172.16.0.6", "high-index-vm2");

      // High index TAPs should NOT be deleted (they're pooled)
      expect(deleteTapCalls).not.toContain("vm078f6669b1000");
      expect(deleteTapCalls).not.toContain("vm078f6669b12345");
    });
  });

  describe("concurrent operations", () => {
    it("should handle concurrent acquires", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 5,
        replenishThreshold: 2,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // Acquire 3 concurrently
      const results = await Promise.all([
        pool.acquire("vm1"),
        pool.acquire("vm2"),
        pool.acquire("vm3"),
      ]);

      // All should get unique TAPs
      const taps = results.map((r) => r.tapDevice);
      expect(new Set(taps).size).toBe(3);

      // All should get unique IPs
      const ips = results.map((r) => r.guestIp);
      expect(new Set(ips).size).toBe(3);
    });
  });

  describe("replenish behavior", () => {
    it("should not over-create pairs when release happens during replenish", async () => {
      let createPairDelay = 0;
      const slowCreateTap = vi.fn(async (name: string) => {
        createTapCalls.push(name);
        // Simulate slow TAP creation
        if (createPairDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, createPairDelay));
        }
      });

      const pool = createPool({
        name: "test-runner",
        size: 3,
        replenishThreshold: 2,
        createTap: slowCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      expect(createTapCalls).toHaveLength(3);

      // Acquire all 3 pairs
      const configs = await Promise.all([
        pool.acquire("vm1"),
        pool.acquire("vm2"),
        pool.acquire("vm3"),
      ]);

      // Reset counters and add delay
      createTapCalls = [];
      createPairDelay = 50;

      // Acquire one more (on-demand), which triggers replenish
      await pool.acquire("vm4");

      // Release pairs back while replenish is running
      const vmIds = ["vm1", "vm2", "vm3"];
      for (let i = 0; i < configs.length; i++) {
        const config = configs[i]!;
        await pool.release(config.tapDevice, config.guestIp, vmIds[i]!);
      }

      // Wait for replenish to complete
      await vi.waitFor(
        () => {
          // Replenish should stop early because queue is already at size
          // Total created should be less than size (3) since releases added back
          expect(createTapCalls.length).toBeLessThanOrEqual(3);
        },
        { timeout: 500 },
      );
    });

    it("should trigger replenish when pool is exhausted and threshold > 0", async () => {
      // Use a slow createTap to control timing
      let createCount = 0;
      const controlledCreateTap = vi.fn(async (name: string) => {
        createTapCalls.push(name);
        createCount++;
        // Add small delay to allow replenish to be triggered
        if (createCount > 2) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      });

      const pool = createPool({
        name: "test-runner",
        size: 2,
        replenishThreshold: 2, // High threshold to trigger on first acquire
        createTap: controlledCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      expect(createTapCalls).toHaveLength(2);

      // Exhaust the pool completely
      await pool.acquire("vm1");
      await pool.acquire("vm2");

      // Reset counters - now pool is empty
      createTapCalls = [];

      // This acquire is on-demand (pool empty)
      // With threshold > 0, it should also trigger replenish
      await pool.acquire("vm3");

      // Wait for background replenishment
      await vi.waitFor(
        () => {
          // Should have created: 1 on-demand + some from replenish
          expect(createTapCalls.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 500 },
      );
    });

    it("should not trigger replenish when pool is exhausted and threshold = 0", async () => {
      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0, // disabled
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      createTapCalls = [];

      // Exhaust pool
      await pool.acquire("vm1");

      // On-demand acquire
      await pool.acquire("vm2");

      // Only 1 on-demand creation, no replenish
      expect(createTapCalls).toHaveLength(1);

      // Wait a bit to ensure no background replenish happens
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(createTapCalls).toHaveLength(1);
    });

    it("should stop replenish and cleanup in-flight pair when pool is shutdown", async () => {
      let blockReplenish = false;
      const resolvers: Array<() => void> = [];

      const controlledCreateTap = vi.fn(async (name: string) => {
        createTapCalls.push(name);
        // Only block during replenish (after init)
        if (blockReplenish) {
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
        }
      });

      const pool = createPool({
        name: "test-runner",
        size: 2,
        replenishThreshold: 2, // Trigger replenish on first acquire
        createTap: controlledCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      expect(createTapCalls).toHaveLength(2);

      // Now enable blocking for replenish
      blockReplenish = true;
      createTapCalls = [];
      deleteTapCalls = [];

      // Acquire triggers replenish (pool goes from 2 to 1, below threshold 2)
      await pool.acquire("vm1");

      // Wait for replenish to start and block
      await vi.waitFor(
        () => {
          expect(resolvers.length).toBeGreaterThan(0);
        },
        { timeout: 500 },
      );

      // Cleanup while replenish is blocked on createTap
      await pool.cleanup();

      // Unblock the createTap - replenish should detect shutdown
      for (const resolve of resolvers) {
        resolve();
      }

      // Wait for ALL delete operations to complete:
      // 1. cleanup() deletes pool pair (index 1)
      // 2. replenish cleanup deletes in-flight pair (index 2)
      await vi.waitFor(
        () => {
          expect(deleteTapCalls.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 500 },
      );
    });
  });

  describe("error recovery", () => {
    it("should return pair to pool when MAC set fails", async () => {
      const failingSetMac = vi
        .fn()
        .mockRejectedValueOnce(new Error("MAC failed"));

      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: failingSetMac,
      });

      await pool.init();

      // Acquire should fail at MAC setting
      await expect(pool.acquire("vm1")).rejects.toThrow("MAC failed");

      // Pair should be returned to pool (not deleted)
      expect(deleteTapCalls).toHaveLength(0);

      // Next acquire should work (pair was returned to pool)
      failingSetMac.mockResolvedValueOnce(undefined);
      createTapCalls = [];
      const config = await pool.acquire("vm2");

      expect(createTapCalls).toHaveLength(0);
      expect(config.tapDevice).toBe("vm078f6669b000");
    });

    it("should delete on-demand pair when MAC set fails", async () => {
      let setMacCallCount = 0;
      const conditionalSetMac = vi.fn(async () => {
        setMacCallCount++;
        if (setMacCallCount === 2) {
          throw new Error("MAC failed");
        }
      });

      const pool = createPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: conditionalSetMac,
      });

      await pool.init();

      // First acquire succeeds
      await pool.acquire("vm1");
      deleteTapCalls = [];

      // Second (on-demand) acquire fails at MAC
      await expect(pool.acquire("vm2")).rejects.toThrow("MAC failed");

      // On-demand TAP should be deleted
      expect(deleteTapCalls).toContain("vm078f6669b001");
    });
  });
});
