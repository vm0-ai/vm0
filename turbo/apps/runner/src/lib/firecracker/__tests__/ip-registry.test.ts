import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

// Mock fs before importing the module
vi.mock("node:fs");

// Track exec mock results
let execMockResults: Map<string, { stdout: string; stderr: string } | Error> =
  new Map();

// Mock child_process with promisify-compatible implementation
vi.mock("node:child_process", () => ({
  exec: vi.fn(
    (
      cmd: string,
      callback?: (
        error: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      const result = execMockResults.get(cmd) ??
        [...execMockResults.entries()].find(([pattern]) =>
          cmd.includes(pattern),
        )?.[1] ?? { stdout: "", stderr: "" };

      if (callback) {
        if (result instanceof Error) {
          callback(result, { stdout: "", stderr: "" });
        } else {
          callback(null, result);
        }
      }
      return {} as ReturnType<typeof import("node:child_process").exec>;
    },
  ),
}));

// Mock paths
vi.mock("../../paths.js", () => ({
  VM0_RUN_DIR: "/tmp/vm0-test",
  runtimePaths: {
    ipPoolLock: "/tmp/vm0-test/ip-pool.lock",
    ipRegistry: "/tmp/vm0-test/ip-registry.json",
  },
}));

// Import after mocks are set up
import {
  allocateIP,
  releaseIP,
  cleanupOrphanedIPs,
  assignVmIdToIP,
  clearVmIdFromIP,
  getAllocations,
  getIPForVm,
} from "../ip-registry.js";

describe("IP Registry", () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
    execMockResults = new Map();

    // Default: run dir exists
    mockFs.existsSync.mockImplementation((path) => {
      if (path === "/tmp/vm0-test") return true;
      if (path === "/tmp/vm0-test/ip-registry.json") return false;
      return false;
    });

    // Default: lock file doesn't exist (can acquire immediately)
    mockFs.writeFileSync.mockImplementation(() => {});
    mockFs.unlinkSync.mockImplementation(() => {});
    mockFs.readFileSync.mockImplementation(() => "{}");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("allocateIP", () => {
    it("should allocate first available IP (172.16.0.2)", async () => {
      let savedRegistry: string | null = null;
      mockFs.writeFileSync.mockImplementation((path, data) => {
        if (String(path).includes("ip-registry.json")) {
          savedRegistry = String(data);
        }
      });

      const ip = await allocateIP("tap000");

      expect(ip).toBe("172.16.0.2");
      expect(savedRegistry).not.toBeNull();
      const registry = JSON.parse(savedRegistry!);
      expect(registry.allocations["172.16.0.2"]).toEqual({
        tapDevice: "tap000",
        vmId: null,
      });
    });

    it("should allocate sequential IPs", async () => {
      // Simulate existing allocation
      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({
            allocations: {
              "172.16.0.2": { tapDevice: "tap000", vmId: null },
              "172.16.0.3": { tapDevice: "tap001", vmId: null },
            },
          });
        }
        return "";
      });

      const ip = await allocateIP("tap002");

      expect(ip).toBe("172.16.0.4");
    });

    it("should throw when all IPs are exhausted", async () => {
      // Create full allocation (all 253 IPs used)
      const fullAllocations: Record<string, { tapDevice: string; vmId: null }> =
        {};
      for (let i = 2; i <= 254; i++) {
        fullAllocations[`172.16.0.${i}`] = { tapDevice: `tap${i}`, vmId: null };
      }

      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({ allocations: fullAllocations });
        }
        return "";
      });

      await expect(allocateIP("tap-new")).rejects.toThrow(
        "No free IP addresses available",
      );
    });
  });

  describe("releaseIP", () => {
    it("should remove IP from registry", async () => {
      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({
            allocations: {
              "172.16.0.2": { tapDevice: "tap000", vmId: "vm1" },
            },
          });
        }
        return "";
      });

      let savedRegistry: string | null = null;
      mockFs.writeFileSync.mockImplementation((path, data) => {
        if (String(path).includes("ip-registry.json")) {
          savedRegistry = String(data);
        }
      });

      await releaseIP("172.16.0.2");

      expect(savedRegistry).not.toBeNull();
      const registry = JSON.parse(savedRegistry!);
      expect(registry.allocations["172.16.0.2"]).toBeUndefined();
    });

    it("should do nothing when releasing non-existent IP", async () => {
      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({ allocations: {} });
        }
        return "";
      });

      // Should not throw
      await expect(releaseIP("172.16.0.99")).resolves.toBeUndefined();
    });
  });

  describe("vmId tracking", () => {
    it("should assign vmId to IP allocation", async () => {
      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({
            allocations: {
              "172.16.0.2": { tapDevice: "tap000", vmId: null },
            },
          });
        }
        return "";
      });

      let savedRegistry: string | null = null;
      mockFs.writeFileSync.mockImplementation((path, data) => {
        if (String(path).includes("ip-registry.json")) {
          savedRegistry = String(data);
        }
      });

      await assignVmIdToIP("172.16.0.2", "test-vm-123");

      expect(savedRegistry).not.toBeNull();
      const registry = JSON.parse(savedRegistry!);
      expect(registry.allocations["172.16.0.2"].vmId).toBe("test-vm-123");
    });

    it("should clear vmId from IP allocation when vmId matches", async () => {
      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({
            allocations: {
              "172.16.0.2": { tapDevice: "tap000", vmId: "test-vm-123" },
            },
          });
        }
        return "";
      });

      let savedRegistry: string | null = null;
      mockFs.writeFileSync.mockImplementation((path, data) => {
        if (String(path).includes("ip-registry.json")) {
          savedRegistry = String(data);
        }
      });

      await clearVmIdFromIP("172.16.0.2", "test-vm-123");

      expect(savedRegistry).not.toBeNull();
      const registry = JSON.parse(savedRegistry!);
      expect(registry.allocations["172.16.0.2"].vmId).toBeNull();
    });

    it("should not clear vmId when expectedVmId does not match", async () => {
      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({
            allocations: {
              "172.16.0.2": { tapDevice: "tap000", vmId: "new-vm-456" },
            },
          });
        }
        return "";
      });

      let savedRegistry: string | null = null;
      mockFs.writeFileSync.mockImplementation((path, data) => {
        if (String(path).includes("ip-registry.json")) {
          savedRegistry = String(data);
        }
      });

      // Try to clear with old vmId - should not clear because current vmId is different
      await clearVmIdFromIP("172.16.0.2", "old-vm-123");

      // Should not have written to registry (vmId didn't match)
      expect(savedRegistry).toBeNull();
    });
  });

  describe("diagnostic functions", () => {
    it("getAllocations should return all allocations as Map", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({
            allocations: {
              "172.16.0.2": { tapDevice: "tap000", vmId: "vm1" },
              "172.16.0.3": { tapDevice: "tap001", vmId: null },
            },
          });
        }
        return "";
      });

      const allocations = getAllocations();

      expect(allocations).toBeInstanceOf(Map);
      expect(allocations.size).toBe(2);
      expect(allocations.get("172.16.0.2")).toEqual({
        tapDevice: "tap000",
        vmId: "vm1",
      });
    });

    it("getIPForVm should find IP by vmId", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({
            allocations: {
              "172.16.0.2": { tapDevice: "tap000", vmId: "vm1" },
              "172.16.0.3": { tapDevice: "tap001", vmId: "vm2" },
            },
          });
        }
        return "";
      });

      expect(getIPForVm("vm1")).toBe("172.16.0.2");
      expect(getIPForVm("vm2")).toBe("172.16.0.3");
      expect(getIPForVm("vm-not-found")).toBeUndefined();
    });
  });

  describe("cleanupOrphanedIPs", () => {
    it("should remove IPs whose TAP devices no longer exist", async () => {
      // Mock: TAP scan returns only tap001, tap000 check fails
      execMockResults.set("ip -o link show type tuntap", {
        stdout: "2: tap001: <BROADCAST,MULTICAST,UP>\n",
        stderr: "",
      });
      execMockResults.set("ip link show tap000", new Error("Device not found"));
      execMockResults.set("ip link show tap001", {
        stdout: "tap001",
        stderr: "",
      });

      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({
            allocations: {
              "172.16.0.2": { tapDevice: "tap000", vmId: null }, // orphaned
              "172.16.0.3": { tapDevice: "tap001", vmId: "vm1" }, // exists
            },
          });
        }
        return "";
      });

      let savedRegistry: string | null = null;
      mockFs.writeFileSync.mockImplementation((path, data) => {
        if (String(path).includes("ip-registry.json")) {
          savedRegistry = String(data);
        }
      });

      await cleanupOrphanedIPs();

      expect(savedRegistry).not.toBeNull();
      const registry = JSON.parse(savedRegistry!);
      expect(registry.allocations["172.16.0.2"]).toBeUndefined(); // removed
      expect(registry.allocations["172.16.0.3"]).toBeDefined(); // kept
    });

    it("should not modify registry when no orphans found", async () => {
      // Mock: TAP scan returns both tap000 and tap001
      execMockResults.set("ip -o link show type tuntap", {
        stdout: "2: tap000: <BROADCAST>\n3: tap001: <BROADCAST>\n",
        stderr: "",
      });

      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({
            allocations: {
              "172.16.0.2": { tapDevice: "tap000", vmId: null },
              "172.16.0.3": { tapDevice: "tap001", vmId: null },
            },
          });
        }
        return "";
      });

      const writeFileSpy = vi.fn();
      mockFs.writeFileSync.mockImplementation((path, data) => {
        if (String(path).includes("ip-registry.json")) {
          writeFileSpy(path, data);
        }
      });

      await cleanupOrphanedIPs();

      // Registry should not be written (no changes)
      expect(writeFileSpy).not.toHaveBeenCalled();
    });
  });

  describe("file lock", () => {
    it("should acquire and release lock", async () => {
      const lockWrites: string[] = [];
      const lockDeletes: string[] = [];

      mockFs.writeFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-pool.lock")) {
          lockWrites.push(String(path));
        }
      });
      mockFs.unlinkSync.mockImplementation((path) => {
        if (String(path).includes("ip-pool.lock")) {
          lockDeletes.push(String(path));
        }
      });

      await allocateIP("tap000");

      // Lock should be acquired and released
      expect(lockWrites.length).toBeGreaterThan(0);
      expect(lockDeletes.length).toBeGreaterThan(0);
    });

    it("should retry when lock is held by another process", async () => {
      let lockAttempts = 0;

      mockFs.writeFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-pool.lock")) {
          lockAttempts++;
          if (lockAttempts < 3) {
            // Simulate lock file exists
            const error = new Error("EEXIST") as NodeJS.ErrnoException;
            error.code = "EEXIST";
            throw error;
          }
        }
      });

      // Mock reading lock file to see dead process
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-pool.lock")) {
          return "99999"; // Non-existent PID
        }
        if (String(path).includes("ip-registry.json")) {
          return JSON.stringify({ allocations: {} });
        }
        return "";
      });

      // process.kill should throw for non-existent PID
      const originalKill = process.kill;
      process.kill = vi.fn().mockImplementation(() => {
        throw new Error("ESRCH");
      }) as typeof process.kill;

      try {
        await allocateIP("tap000");
        expect(lockAttempts).toBe(3);
      } finally {
        process.kill = originalKill;
      }
    });
  });

  describe("corrupted registry", () => {
    it("should start fresh when registry is corrupted", async () => {
      mockFs.existsSync.mockImplementation((path) => {
        if (path === "/tmp/vm0-test") return true;
        if (path === "/tmp/vm0-test/ip-registry.json") return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) {
          return "{ invalid json }}}";
        }
        return "";
      });

      let savedRegistry: string | null = null;
      mockFs.writeFileSync.mockImplementation((path, data) => {
        if (String(path).includes("ip-registry.json")) {
          savedRegistry = String(data);
        }
      });

      const ip = await allocateIP("tap000");

      // Should allocate first IP (starting fresh)
      expect(ip).toBe("172.16.0.2");
      expect(savedRegistry).not.toBeNull();
    });
  });
});
