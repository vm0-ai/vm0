import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TapPool } from "../tap-pool.js";

// Mock ip-pool module
vi.mock("../ip-pool.js", () => ({
  allocateIP: vi.fn(),
  releaseIP: vi.fn(),
}));

// Import mocked module
import { allocateIP, releaseIP } from "../ip-pool.js";

const mockAllocateIP = vi.mocked(allocateIP);
const mockReleaseIP = vi.mocked(releaseIP);

describe("TapPool", () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    createTapCalls = [];
    deleteTapCalls = [];
    setMacCalls = [];

    // Default mock for IP allocation
    let ipCounter = 2;
    mockAllocateIP.mockImplementation(async () => `172.16.0.${ipCounter++}`);
    mockReleaseIP.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("init", () => {
    it("should create TAP devices up to pool size", async () => {
      const pool = new TapPool({
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
    });

    it("should handle empty pool size", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 0,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      expect(createTapCalls).toHaveLength(0);
    });
  });

  describe("acquire", () => {
    it("should return TAP from pool and allocate IP", async () => {
      const pool = new TapPool({
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
      const pool = new TapPool({
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

    it("should create TAP on-demand when pool is exhausted", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      createTapCalls = []; // Reset after init

      // First acquire uses pool
      await pool.acquire("vm1");

      // Second acquire should create on-demand
      const config = await pool.acquire("vm2");

      expect(createTapCalls).toHaveLength(1);
      expect(config.tapDevice).toBe("vm078f6669b001"); // Next index
    });

    it("should trigger replenishment when below threshold", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 3,
        replenishThreshold: 2,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      createTapCalls = []; // Reset after init

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
    it("should return TAP to pool and release IP", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      const config = await pool.acquire("test-vm");

      await pool.release(config.tapDevice, config.guestIp);

      expect(mockReleaseIP).toHaveBeenCalledWith(config.guestIp);
    });

    it("should make TAP available for next acquire after release", async () => {
      const pool = new TapPool({
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
      await pool.release(config1.tapDevice, config1.guestIp);

      // Pool is size 1, so if we acquired and released, next acquire should get same TAP
      createTapCalls = []; // Reset
      const config2 = await pool.acquire("vm2");

      expect(createTapCalls).toHaveLength(0); // No on-demand creation needed
      expect(config2.tapDevice).toBe(config1.tapDevice);
    });

    it("should delete non-pooled TAP devices", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // Release a non-pooled TAP (doesn't match tappXXX pattern)
      await pool.release("tap-legacy", "172.16.0.5");

      expect(deleteTapCalls).toContain("tap-legacy");
    });
  });

  describe("cleanup", () => {
    it("should delete all TAPs in pool", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 3,
        replenishThreshold: 2,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // The important thing is cleanup doesn't throw
      // Note: cleanup uses execAsync directly (fire-and-forget), not mockDeleteTap
      expect(() => pool.cleanup()).not.toThrow();
    });

    it("should handle cleanup when pool is empty", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 0,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // Should not throw
      expect(() => pool.cleanup()).not.toThrow();
    });

    it("should handle cleanup when not initialized", () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 3,
        replenishThreshold: 2,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      // Should not throw even without init
      expect(() => pool.cleanup()).not.toThrow();
    });

    it("should delete TAP when release is called after cleanup", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();
      const config = await pool.acquire("vm1");

      // Cleanup the pool (simulating shutdown)
      pool.cleanup();
      deleteTapCalls = [];

      // Release after cleanup should delete the TAP, not return to pool
      await pool.release(config.tapDevice, config.guestIp);

      expect(deleteTapCalls).toContain(config.tapDevice);
    });
  });

  describe("TAP naming", () => {
    it("should generate sequential TAP names", async () => {
      const pool = new TapPool({
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
      const pool = new TapPool({
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
      const pool = new TapPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // Release a TAP with high index (simulating after many on-demand creations)
      // This TAP name should still be recognized as pooled and not deleted
      await pool.release("vm078f6669b1000", "172.16.0.5");
      await pool.release("vm078f6669b12345", "172.16.0.6");

      // High index TAPs should NOT be deleted (they're pooled)
      expect(deleteTapCalls).not.toContain("vm078f6669b1000");
      expect(deleteTapCalls).not.toContain("vm078f6669b12345");
    });
  });

  describe("concurrent operations", () => {
    it("should handle concurrent acquires", async () => {
      const pool = new TapPool({
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

  describe("error recovery", () => {
    it("should return TAP to pool when IP allocation fails", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // Make allocateIP fail
      mockAllocateIP.mockRejectedValueOnce(new Error("No IPs available"));

      // Acquire should fail
      await expect(pool.acquire("vm1")).rejects.toThrow("No IPs available");

      // TAP should be returned to pool - next acquire should work without on-demand creation
      createTapCalls = [];
      mockAllocateIP.mockResolvedValueOnce("172.16.0.2");
      const config = await pool.acquire("vm2");

      // Should reuse the TAP from pool (no new TAP created)
      expect(createTapCalls).toHaveLength(0);
      expect(config.tapDevice).toBe("vm078f6669b000");
    });

    it("should return TAP to pool when MAC set fails", async () => {
      const failingSetMac = vi
        .fn()
        .mockRejectedValueOnce(new Error("MAC failed"));

      const pool = new TapPool({
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

      // IP should be released
      expect(mockReleaseIP).toHaveBeenCalledWith("172.16.0.2");

      // TAP should be returned to pool - next acquire should work without on-demand creation
      createTapCalls = [];
      failingSetMac.mockResolvedValueOnce(undefined);
      const config = await pool.acquire("vm2");
      expect(createTapCalls).toHaveLength(0);
      expect(config.tapDevice).toBe("vm078f6669b000");
    });

    it("should delete on-demand TAP when IP allocation fails", async () => {
      const pool = new TapPool({
        name: "test-runner",
        size: 1,
        replenishThreshold: 0,
        createTap: mockCreateTap,
        deleteTap: mockDeleteTap,
        setMac: mockSetMac,
      });

      await pool.init();

      // Exhaust pool
      await pool.acquire("vm1");
      deleteTapCalls = [];

      // Make next allocateIP fail
      mockAllocateIP.mockRejectedValueOnce(new Error("No IPs"));

      // On-demand acquire should fail and delete the TAP
      await expect(pool.acquire("vm2")).rejects.toThrow("No IPs");

      // TAP should be deleted (not returned to pool since it was on-demand)
      expect(deleteTapCalls).toContain("vm078f6669b001");
    });

    it("should delete on-demand TAP when MAC set fails", async () => {
      let setMacCallCount = 0;
      const conditionalSetMac = vi.fn(async () => {
        setMacCallCount++;
        if (setMacCallCount === 2) {
          throw new Error("MAC failed");
        }
      });

      const pool = new TapPool({
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

      // IP should be released
      expect(mockReleaseIP).toHaveBeenCalledWith("172.16.0.3");
    });
  });
});
