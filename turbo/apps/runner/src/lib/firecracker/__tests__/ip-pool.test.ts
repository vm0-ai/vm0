import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

// Type for IP registry
interface IPAllocation {
  vmId: string;
  tapDevice: string;
  allocatedAt: string;
}
interface IPRegistry {
  allocations: Record<string, IPAllocation>;
}

// Track mock exec results - this will be used by both callback and promisified versions
let mockExecStdout = "";
let mockExecStderr = "";

// Mock the modules - vi.mock is hoisted so this runs first
vi.mock("node:fs");
vi.mock("node:child_process", () => {
  // Use the well-known symbol for custom promisify
  const kCustomPromisifiedSymbol = Symbol.for("nodejs.util.promisify.custom");

  const execMock = vi.fn(
    (
      _cmd: string,
      callback?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (callback) {
        callback(null, mockExecStdout, mockExecStderr);
      }
      return {} as unknown;
    },
  );

  // Add custom promisify implementation that returns { stdout, stderr }
  (execMock as unknown as Record<symbol, unknown>)[kCustomPromisifiedSymbol] =
    vi.fn(async () => ({ stdout: mockExecStdout, stderr: mockExecStderr }));

  return { exec: execMock };
});

// Import after mocking
import {
  allocateIP,
  releaseIP,
  cleanupOrphanedAllocations,
} from "../ip-pool.js";

const mockFs = vi.mocked(fs);

describe("IP Pool Manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks for ensureRunDir
    mockFs.existsSync.mockReturnValue(true);

    // Reset default exec result
    mockExecStdout = "";
    mockExecStderr = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("allocateIP", () => {
    it("should allocate first available IP (172.16.0.2) when pool is empty", async () => {
      // Mock empty registry
      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return false;
        if (String(path).includes("lock.active")) return false;
        return true; // VM0_RUN_DIR exists
      });

      // Mock successful lock acquisition
      mockFs.writeFileSync.mockImplementation(() => undefined);
      mockFs.unlinkSync.mockImplementation(() => undefined);

      const ip = await allocateIP("test-vm-1234");

      expect(ip).toBe("172.16.0.2");
    });

    it("should allocate next available IP when some are already allocated", async () => {
      const existingRegistry = {
        allocations: {
          "172.16.0.2": {
            vmId: "existing-vm",
            tapDevice: "tapexistin",
            allocatedAt: new Date().toISOString(),
          },
        },
      };

      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return true;
        if (String(path).includes("lock.active")) return false;
        return true;
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingRegistry));
      mockFs.writeFileSync.mockImplementation(() => undefined);
      mockFs.unlinkSync.mockImplementation(() => undefined);

      const ip = await allocateIP("new-vm-5678");

      expect(ip).toBe("172.16.0.3");
    });

    it("should throw when no IPs are available", async () => {
      // Create a registry with all IPs allocated
      const allocations: Record<
        string,
        { vmId: string; tapDevice: string; allocatedAt: string }
      > = {};
      for (let i = 2; i <= 254; i++) {
        allocations[`172.16.0.${i}`] = {
          vmId: `vm-${i}`,
          tapDevice: `tapvm${i}`,
          allocatedAt: new Date().toISOString(),
        };
      }
      const fullRegistry = { allocations };

      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return true;
        if (String(path).includes("lock.active")) return false;
        return true;
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify(fullRegistry));
      mockFs.writeFileSync.mockImplementation(() => undefined);
      mockFs.unlinkSync.mockImplementation(() => undefined);

      await expect(allocateIP("overflow-vm")).rejects.toThrow(
        "No free IP addresses available in pool",
      );
    });

    it("should use first 8 chars of vmId for TAP device name", async () => {
      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return false;
        if (String(path).includes("lock.active")) return false;
        return true;
      });

      let writtenRegistry: IPRegistry | null = null;
      mockFs.writeFileSync.mockImplementation((_path, content) => {
        if (String(_path).includes("ip-registry.json")) {
          writtenRegistry = JSON.parse(content as string) as IPRegistry;
        }
      });
      mockFs.unlinkSync.mockImplementation(() => undefined);

      await allocateIP("abcdefghijklmnop");

      expect(writtenRegistry!.allocations["172.16.0.2"]?.tapDevice).toBe(
        "tapabcdefgh",
      );
    });
  });

  describe("releaseIP", () => {
    it("should remove IP from registry when released", async () => {
      const existingRegistry = {
        allocations: {
          "172.16.0.2": {
            vmId: "test-vm",
            tapDevice: "taptest-vm",
            allocatedAt: new Date().toISOString(),
          },
        },
      };

      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return true;
        if (String(path).includes("lock.active")) return false;
        return true;
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingRegistry));

      let writtenRegistry: IPRegistry | null = null;
      mockFs.writeFileSync.mockImplementation((_path, content) => {
        if (String(_path).includes("ip-registry.json")) {
          writtenRegistry = JSON.parse(content as string) as IPRegistry;
        }
      });
      mockFs.unlinkSync.mockImplementation(() => undefined);

      await releaseIP("172.16.0.2");

      expect(writtenRegistry!.allocations["172.16.0.2"]).toBeUndefined();
    });

    it("should handle releasing IP that was not allocated", async () => {
      const existingRegistry = { allocations: {} };

      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return true;
        if (String(path).includes("lock.active")) return false;
        return true;
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingRegistry));
      mockFs.writeFileSync.mockImplementation(() => undefined);
      mockFs.unlinkSync.mockImplementation(() => undefined);

      // Should not throw
      await expect(releaseIP("172.16.0.99")).resolves.toBeUndefined();
    });
  });

  describe("cleanupOrphanedAllocations", () => {
    it("should remove allocations without active TAP devices", async () => {
      const oldAllocation = new Date(Date.now() - 60000).toISOString(); // 60 seconds ago
      const existingRegistry = {
        allocations: {
          "172.16.0.2": {
            vmId: "orphan-vm",
            tapDevice: "taporphanv",
            allocatedAt: oldAllocation,
          },
        },
      };

      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return true;
        if (String(path).includes("lock.active")) return false;
        return true;
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingRegistry));

      // Mock exec for TAP device scan - return empty (no TAP devices)
      // mockExecStdout/Stderr are already empty by default

      let writtenRegistry: IPRegistry | null = null;
      mockFs.writeFileSync.mockImplementation((_path, content) => {
        if (String(_path).includes("ip-registry.json")) {
          writtenRegistry = JSON.parse(content as string) as IPRegistry;
        }
      });
      mockFs.unlinkSync.mockImplementation(() => undefined);

      await cleanupOrphanedAllocations();

      // Orphan should be removed
      expect(writtenRegistry!.allocations["172.16.0.2"]).toBeUndefined();
    });

    it("should keep allocations within grace period even without TAP device", async () => {
      const recentAllocation = new Date().toISOString(); // Just now
      const existingRegistry = {
        allocations: {
          "172.16.0.2": {
            vmId: "new-vm",
            tapDevice: "tapnew-vm",
            allocatedAt: recentAllocation,
          },
        },
      };

      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return true;
        if (String(path).includes("lock.active")) return false;
        return true;
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingRegistry));

      // Mock exec for TAP device scan - return empty (no TAP devices)
      // mockExecStdout/Stderr are already empty by default

      let writtenRegistry: IPRegistry | null = null;
      mockFs.writeFileSync.mockImplementation((_path, content) => {
        if (String(_path).includes("ip-registry.json")) {
          writtenRegistry = JSON.parse(content as string) as IPRegistry;
        }
      });
      mockFs.unlinkSync.mockImplementation(() => undefined);

      await cleanupOrphanedAllocations();

      // Recent allocation should be kept (within grace period)
      // Note: writtenRegistry might be null if no write happened (no changes)
      // In this case, the allocation should still exist
      expect(writtenRegistry).toBeNull(); // No write because nothing changed
    });

    it("should keep allocations with active TAP devices", async () => {
      const oldAllocation = new Date(Date.now() - 60000).toISOString();
      // Use hex-compatible vmId since TAP device regex expects [a-f0-9]+
      const existingRegistry = {
        allocations: {
          "172.16.0.2": {
            vmId: "a1b2c3d4e5f6",
            tapDevice: "tapa1b2c3d4",
            allocatedAt: oldAllocation,
          },
        },
      };

      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return true;
        if (String(path).includes("lock.active")) return false;
        return true;
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingRegistry));

      // Mock exec for TAP device scan - return active TAP device
      mockExecStdout =
        "5: tapa1b2c3d4: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500";

      let writtenRegistry: IPRegistry | null = null;
      mockFs.writeFileSync.mockImplementation((_path, content) => {
        if (String(_path).includes("ip-registry.json")) {
          writtenRegistry = JSON.parse(content as string) as IPRegistry;
        }
      });
      mockFs.unlinkSync.mockImplementation(() => undefined);

      await cleanupOrphanedAllocations();

      // No changes should be written since TAP exists
      expect(writtenRegistry).toBeNull();
    });
  });

  describe("IP range validation", () => {
    it("should allocate IPs in range 172.16.0.2 to 172.16.0.254", async () => {
      // First IP should be .2 (not .1 which is the gateway)
      mockFs.existsSync.mockImplementation((path) => {
        if (String(path).includes("ip-registry.json")) return false;
        if (String(path).includes("lock.active")) return false;
        return true;
      });

      mockFs.writeFileSync.mockImplementation(() => undefined);
      mockFs.unlinkSync.mockImplementation(() => undefined);

      const ip = await allocateIP("test-vm");

      expect(ip).toBe("172.16.0.2");
      expect(ip).not.toBe("172.16.0.1"); // Gateway
      expect(ip).not.toBe("172.16.0.0"); // Network
      expect(ip).not.toBe("172.16.0.255"); // Broadcast
    });
  });
});
