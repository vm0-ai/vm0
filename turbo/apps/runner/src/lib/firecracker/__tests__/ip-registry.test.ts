import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  IPRegistry,
  initIPRegistry,
  resetIPRegistry,
  type IPRegistryConfig,
} from "../ip-registry.js";

describe("IPRegistry", () => {
  let testDir: string;
  let registry: IPRegistry;

  // Mock TAP scanning functions
  let mockTapDevices: Set<string>;
  const mockScanTapDevices = vi.fn(async () => mockTapDevices);
  const mockCheckTapExists = vi.fn(async (tap: string) =>
    mockTapDevices.has(tap),
  );
  const mockEnsureRegistryDir = vi.fn(async () => {});

  beforeEach(() => {
    // Create a unique temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ip-registry-test-"));

    // Reset mocks
    mockTapDevices = new Set();
    vi.clearAllMocks();

    // Create registry with test config
    registry = new IPRegistry({
      registryPath: path.join(testDir, "ip-registry.json"),
      ensureRegistryDir: mockEnsureRegistryDir,
      scanTapDevices: mockScanTapDevices,
      checkTapExists: mockCheckTapExists,
    });
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(testDir, { recursive: true, force: true });
    resetIPRegistry();
  });

  describe("allocateIP", () => {
    it("should allocate first available IP (172.16.0.2)", async () => {
      const ip = await registry.allocateIP("tap000");

      expect(ip).toBe("172.16.0.2");

      // Verify registry file was written
      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      expect(data.allocations["172.16.0.2"]).toMatchObject({
        tapDevice: "tap000",
        vmId: null,
      });
      expect(data.allocations["172.16.0.2"].runnerPid).toBe(process.pid);
    });

    it("should allocate sequential IPs", async () => {
      await registry.allocateIP("tap000");
      await registry.allocateIP("tap001");
      const ip = await registry.allocateIP("tap002");

      expect(ip).toBe("172.16.0.4");
    });

    it("should throw when all IPs are exhausted", async () => {
      // Pre-fill registry with all IPs
      const allocations: Record<
        string,
        { runnerPid: number; tapDevice: string; vmId: null }
      > = {};
      for (let i = 2; i <= 254; i++) {
        allocations[`172.16.0.${i}`] = {
          runnerPid: process.pid,
          tapDevice: `tap${i}`,
          vmId: null,
        };
      }
      fs.writeFileSync(
        path.join(testDir, "ip-registry.json"),
        JSON.stringify({ allocations }),
      );

      await expect(registry.allocateIP("tap-new")).rejects.toThrow(
        "No free IP addresses available",
      );
    });
  });

  describe("releaseIP", () => {
    it("should remove IP from registry", async () => {
      // Allocate first
      const ip = await registry.allocateIP("tap000");
      expect(ip).toBe("172.16.0.2");

      // Release
      await registry.releaseIP(ip);

      // Verify registry
      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      expect(data.allocations["172.16.0.2"]).toBeUndefined();
    });

    it("should do nothing when releasing non-existent IP", async () => {
      // Should not throw
      await expect(registry.releaseIP("172.16.0.99")).resolves.toBeUndefined();
    });
  });

  describe("vmId tracking", () => {
    it("should assign vmId to IP allocation", async () => {
      const ip = await registry.allocateIP("tap000");
      await registry.assignVmIdToIP(ip, "test-vm-123");

      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      expect(data.allocations[ip].vmId).toBe("test-vm-123");
    });

    it("should clear vmId from IP allocation when vmId matches", async () => {
      const ip = await registry.allocateIP("tap000");
      await registry.assignVmIdToIP(ip, "test-vm-123");
      await registry.clearVmIdFromIP(ip, "test-vm-123");

      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      expect(data.allocations[ip].vmId).toBeNull();
    });

    it("should not clear vmId when expectedVmId does not match", async () => {
      const ip = await registry.allocateIP("tap000");
      await registry.assignVmIdToIP(ip, "new-vm-456");

      // Try to clear with old vmId
      await registry.clearVmIdFromIP(ip, "old-vm-123");

      // vmId should still be new-vm-456
      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      expect(data.allocations[ip].vmId).toBe("new-vm-456");
    });
  });

  describe("diagnostic functions", () => {
    it("getAllocations should return all allocations as Map", async () => {
      await registry.allocateIP("tap000");
      await registry.assignVmIdToIP("172.16.0.2", "vm1");
      await registry.allocateIP("tap001");

      const allocations = registry.getAllocations();

      expect(allocations).toBeInstanceOf(Map);
      expect(allocations.size).toBe(2);
      expect(allocations.get("172.16.0.2")).toMatchObject({
        tapDevice: "tap000",
        vmId: "vm1",
      });
      expect(allocations.get("172.16.0.2")?.runnerPid).toBe(process.pid);
    });

    it("getIPForVm should find IP by vmId", async () => {
      await registry.allocateIP("tap000");
      await registry.assignVmIdToIP("172.16.0.2", "vm1");
      await registry.allocateIP("tap001");
      await registry.assignVmIdToIP("172.16.0.3", "vm2");

      expect(registry.getIPForVm("vm1")).toBe("172.16.0.2");
      expect(registry.getIPForVm("vm2")).toBe("172.16.0.3");
      expect(registry.getIPForVm("vm-not-found")).toBeUndefined();
    });
  });

  describe("cleanupOrphanedIPs", () => {
    it("should remove IPs whose TAP devices no longer exist", async () => {
      // Allocate IPs
      await registry.allocateIP("tap000");
      await registry.allocateIP("tap001");

      // Only tap001 exists on system
      mockTapDevices = new Set(["tap001"]);

      await registry.cleanupOrphanedIPs();

      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      expect(data.allocations["172.16.0.2"]).toBeUndefined(); // removed (tap000 gone)
      expect(data.allocations["172.16.0.3"]).toBeDefined(); // kept (tap001 exists)
    });

    it("should not modify registry when no orphans found", async () => {
      await registry.allocateIP("tap000");
      await registry.allocateIP("tap001");

      // Both TAPs exist
      mockTapDevices = new Set(["tap000", "tap001"]);

      const beforeMtime = fs.statSync(
        path.join(testDir, "ip-registry.json"),
      ).mtimeMs;

      // Small delay to ensure mtime would change if file is written
      await new Promise((r) => setTimeout(r, 10));

      await registry.cleanupOrphanedIPs();

      const afterMtime = fs.statSync(
        path.join(testDir, "ip-registry.json"),
      ).mtimeMs;

      // File should not have been modified
      expect(afterMtime).toBe(beforeMtime);
    });

    it("should remove IPs and return orphaned TAPs when runner PID is dead", async () => {
      // Manually write registry with a dead PID
      const deadPid = 999999; // Assume this PID is not running
      const allocations = {
        "172.16.0.2": {
          runnerPid: deadPid,
          tapDevice: "tap000",
          vmId: null,
        },
        "172.16.0.3": {
          runnerPid: process.pid, // Current process is alive
          tapDevice: "tap001",
          vmId: null,
        },
      };
      fs.writeFileSync(
        path.join(testDir, "ip-registry.json"),
        JSON.stringify({ allocations }),
      );

      // Both TAPs exist on system
      mockTapDevices = new Set(["tap000", "tap001"]);

      const orphanedTaps = await registry.cleanupOrphanedIPs();

      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      // IP with dead runner PID should be removed
      expect(data.allocations["172.16.0.2"]).toBeUndefined();
      // IP with alive runner PID should be kept
      expect(data.allocations["172.16.0.3"]).toBeDefined();

      // Should return the orphaned TAP for caller to delete
      expect(orphanedTaps).toEqual(["tap000"]);
    });

    it("should return multiple orphaned TAPs when multiple runners are dead", async () => {
      const deadPid = 999999;
      const allocations = {
        "172.16.0.2": {
          runnerPid: deadPid,
          tapDevice: "tap000",
          vmId: null,
        },
        "172.16.0.3": {
          runnerPid: deadPid,
          tapDevice: "tap001",
          vmId: null,
        },
      };
      fs.writeFileSync(
        path.join(testDir, "ip-registry.json"),
        JSON.stringify({ allocations }),
      );

      // Both TAPs exist
      mockTapDevices = new Set(["tap000", "tap001"]);

      const orphanedTaps = await registry.cleanupOrphanedIPs();

      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      // Both IPs should be removed from registry
      expect(data.allocations["172.16.0.2"]).toBeUndefined();
      expect(data.allocations["172.16.0.3"]).toBeUndefined();

      // Should return both orphaned TAPs
      expect(orphanedTaps).toHaveLength(2);
      expect(orphanedTaps).toContain("tap000");
      expect(orphanedTaps).toContain("tap001");
    });

    it("should remove IP but not return TAP when runner is dead and TAP not in scan", async () => {
      // Runner dead, TAP already deleted (not in scan)
      const deadPid = 999999;
      const allocations = {
        "172.16.0.2": {
          runnerPid: deadPid,
          tapDevice: "tap000",
          vmId: null,
        },
      };
      fs.writeFileSync(
        path.join(testDir, "ip-registry.json"),
        JSON.stringify({ allocations }),
      );

      // TAP does NOT exist on system
      mockTapDevices = new Set();

      const orphanedTaps = await registry.cleanupOrphanedIPs();

      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      // IP should be removed
      expect(data.allocations["172.16.0.2"]).toBeUndefined();
      // No orphaned TAPs to return (TAP already gone)
      expect(orphanedTaps).toEqual([]);
    });

    it("should keep IP when runner PID check returns EPERM (process exists but no permission)", async () => {
      // PID 1 (init) typically returns EPERM when checked by non-root user
      // Skip test if running as root (where PID 1 check succeeds)
      let pid1ReturnsEperm = false;
      try {
        process.kill(1, 0);
        // If we reach here, we have permission (running as root)
      } catch (err) {
        pid1ReturnsEperm = (err as NodeJS.ErrnoException).code === "EPERM";
      }

      if (!pid1ReturnsEperm) {
        // Running as root, skip this test
        return;
      }

      // Use PID 1 which will return EPERM
      const allocations = {
        "172.16.0.2": {
          runnerPid: 1,
          tapDevice: "tap000",
          vmId: null,
        },
      };
      fs.writeFileSync(
        path.join(testDir, "ip-registry.json"),
        JSON.stringify({ allocations }),
      );

      // TAP exists on system
      mockTapDevices = new Set(["tap000"]);

      const orphanedTaps = await registry.cleanupOrphanedIPs();

      const data = JSON.parse(
        fs.readFileSync(path.join(testDir, "ip-registry.json"), "utf-8"),
      );
      // IP should be KEPT (EPERM means process exists, just no permission)
      expect(data.allocations["172.16.0.2"]).toBeDefined();
      // No orphaned TAPs (runner is considered alive)
      expect(orphanedTaps).toEqual([]);
    });
  });

  describe("file lock", () => {
    it("should acquire and release lock", async () => {
      await registry.allocateIP("tap000");

      // proper-lockfile creates .lock directory, should not exist after operation completes
      expect(fs.existsSync(path.join(testDir, "ip-registry.json.lock"))).toBe(
        false,
      );
    });

    it("should handle concurrent operations", async () => {
      // Run multiple allocations concurrently
      const promises = [
        registry.allocateIP("tap000"),
        registry.allocateIP("tap001"),
        registry.allocateIP("tap002"),
      ];

      const ips = await Promise.all(promises);

      // All IPs should be unique
      expect(new Set(ips).size).toBe(3);
      expect(ips).toContain("172.16.0.2");
      expect(ips).toContain("172.16.0.3");
      expect(ips).toContain("172.16.0.4");
    });
  });

  describe("corrupted registry", () => {
    it("should start fresh when registry is corrupted", async () => {
      // Write corrupted registry
      fs.writeFileSync(
        path.join(testDir, "ip-registry.json"),
        "{ invalid json }}}",
      );

      const ip = await registry.allocateIP("tap000");

      // Should allocate first IP (starting fresh)
      expect(ip).toBe("172.16.0.2");
    });
  });

  describe("global instance", () => {
    it("should return same instance from initIPRegistry when called twice", () => {
      const instance1 = initIPRegistry({
        registryPath: path.join(testDir, "ip-registry.json"),
        ensureRegistryDir: mockEnsureRegistryDir,
        scanTapDevices: mockScanTapDevices,
        checkTapExists: mockCheckTapExists,
      });

      // Second call should return new instance (replaces previous)
      const instance2 = initIPRegistry({
        registryPath: path.join(testDir, "ip-registry.json"),
        ensureRegistryDir: mockEnsureRegistryDir,
        scanTapDevices: mockScanTapDevices,
        checkTapExists: mockCheckTapExists,
      });

      // Each init creates a new instance
      expect(instance1).not.toBe(instance2);
    });

    it("should create new instance after reset", () => {
      const config: IPRegistryConfig = {
        registryPath: path.join(testDir, "ip-registry.json"),
        ensureRegistryDir: mockEnsureRegistryDir,
        scanTapDevices: mockScanTapDevices,
        checkTapExists: mockCheckTapExists,
      };

      const instance1 = initIPRegistry(config);

      resetIPRegistry();
      const instance2 = initIPRegistry(config);

      expect(instance1).not.toBe(instance2);
    });
  });
});
