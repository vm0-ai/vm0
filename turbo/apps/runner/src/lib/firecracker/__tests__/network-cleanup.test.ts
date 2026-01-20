import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track mock exec state - the mock will read from these
interface ExecResponse {
  stdout: string;
  stderr: string;
}
type CommandHandler = (cmd: string) => ExecResponse | Promise<ExecResponse>;
let commandHandler: CommandHandler = () => ({ stdout: "", stderr: "" });

// Mock the modules - vi.mock is hoisted so this runs first
vi.mock("node:child_process", () => {
  // Use the well-known symbol for custom promisify
  const kCustomPromisifiedSymbol = Symbol.for("nodejs.util.promisify.custom");

  const execMock = vi.fn(
    (
      _cmd: string,
      callback?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const result = commandHandler(_cmd);
      if (result instanceof Promise) {
        result
          .then((r) => callback?.(null, r.stdout, r.stderr))
          .catch(() => {}); // Mock doesn't need error handling
      } else {
        callback?.(null, result.stdout, result.stderr);
      }
      return {} as unknown;
    },
  );

  // Add custom promisify implementation
  (execMock as unknown as Record<symbol, unknown>)[kCustomPromisifiedSymbol] =
    vi.fn(async (cmd: string) => commandHandler(cmd));

  return { exec: execMock };
});

// Import after mocking
import { flushBridgeArpCache, cleanupOrphanedProxyRules } from "../network.js";

describe("Network Cleanup Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default handler
    commandHandler = () => ({ stdout: "", stderr: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("flushBridgeArpCache", () => {
    it("should skip if bridge does not exist", async () => {
      // Bridge check throws error (bridge doesn't exist)
      commandHandler = (cmd) => {
        if (cmd.includes("ip link show")) {
          // bridgeExists() returns false when this command fails
          throw new Error("Device does not exist");
        }
        return { stdout: "", stderr: "" };
      };

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await flushBridgeArpCache();

      expect(consoleSpy).toHaveBeenCalledWith(
        "Bridge does not exist, skipping ARP flush",
      );
      consoleSpy.mockRestore();
    });

    it("should skip if no ARP entries exist", async () => {
      commandHandler = (cmd) => {
        if (cmd.includes("ip link show")) {
          return { stdout: "vm0br0", stderr: "" }; // Bridge exists
        }
        if (cmd.includes("ip neigh show")) {
          return { stdout: "", stderr: "" }; // No ARP entries
        }
        return { stdout: "", stderr: "" };
      };

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await flushBridgeArpCache();

      expect(consoleSpy).toHaveBeenCalledWith("No ARP entries on bridge");
      consoleSpy.mockRestore();
    });

    it("should clear ARP entries when they exist", async () => {
      const deletedIps: string[] = [];

      commandHandler = (cmd) => {
        if (cmd.includes("ip link show")) {
          return { stdout: "vm0br0", stderr: "" };
        }
        if (cmd.includes("ip neigh show")) {
          return {
            stdout:
              "172.16.0.2 lladdr 02:00:00:12:34:56 REACHABLE\n172.16.0.3 lladdr 02:00:00:ab:cd:ef STALE",
            stderr: "",
          };
        }
        if (cmd.includes("ip neigh del")) {
          const match = cmd.match(/ip neigh del (\d+\.\d+\.\d+\.\d+)/);
          if (match?.[1]) {
            deletedIps.push(match[1]);
          }
        }
        return { stdout: "", stderr: "" };
      };

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await flushBridgeArpCache();

      expect(deletedIps).toContain("172.16.0.2");
      expect(deletedIps).toContain("172.16.0.3");
      expect(consoleSpy).toHaveBeenCalledWith(
        "Cleared 2 ARP entries from bridge",
      );
      consoleSpy.mockRestore();
    });

    it("should handle ARP read failure gracefully", async () => {
      // Bridge exists but ip neigh show fails
      commandHandler = (cmd) => {
        if (cmd.includes("ip link show")) {
          return { stdout: "vm0br0", stderr: "" }; // Bridge exists
        }
        if (cmd.includes("ip neigh show")) {
          throw new Error("Permission denied");
        }
        return { stdout: "", stderr: "" };
      };

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Should not throw
      await expect(flushBridgeArpCache()).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Warning: Could not flush ARP cache"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("cleanupOrphanedProxyRules", () => {
    it("should skip if no orphaned rules exist", async () => {
      commandHandler = (cmd) => {
        if (cmd.includes("-S PREROUTING")) {
          return { stdout: "-A PREROUTING -j ACCEPT", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      };

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await cleanupOrphanedProxyRules("test-runner");

      expect(consoleSpy).toHaveBeenCalledWith("No orphaned proxy rules found");
      consoleSpy.mockRestore();
    });

    it("should delete orphaned rules for the runner", async () => {
      const deletedRules: string[] = [];

      commandHandler = (cmd) => {
        if (cmd.includes("-S PREROUTING")) {
          return {
            stdout: `-A PREROUTING -s 172.16.0.2/32 -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 3000 -m comment --comment "vm0:runner:test-runner"
-A PREROUTING -s 172.16.0.3/32 -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 3001 -m comment --comment "vm0:runner:test-runner"
-A PREROUTING -s 172.16.0.4/32 -p tcp -m tcp --dport 80 -j REDIRECT --to-ports 3002 -m comment --comment "vm0:runner:other-runner"`,
            stderr: "",
          };
        }
        if (cmd.includes("-D PREROUTING")) {
          deletedRules.push(cmd);
        }
        return { stdout: "", stderr: "" };
      };

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await cleanupOrphanedProxyRules("test-runner");

      // Should delete the 2 rules for test-runner, not the one for other-runner
      expect(deletedRules.length).toBe(2);
      expect(deletedRules[0]).toContain("172.16.0.2");
      expect(deletedRules[1]).toContain("172.16.0.3");
      expect(deletedRules.some((r) => r.includes("172.16.0.4"))).toBe(false);

      expect(consoleSpy).toHaveBeenCalledWith(
        "Found 2 orphaned rule(s) to clean up",
      );
      consoleSpy.mockRestore();
    });

    it("should handle iptables command failure gracefully", async () => {
      commandHandler = () => {
        throw new Error("iptables not available");
      };

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Should not throw
      await expect(
        cleanupOrphanedProxyRules("test-runner"),
      ).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Warning: Could not clean up orphaned rules"),
      );
      consoleSpy.mockRestore();
    });

    it("should continue deleting even if one rule fails", async () => {
      let deleteCallCount = 0;

      commandHandler = (cmd) => {
        if (cmd.includes("-S PREROUTING")) {
          return {
            stdout: `-A PREROUTING -s 172.16.0.2/32 -m comment --comment "vm0:runner:test-runner"
-A PREROUTING -s 172.16.0.3/32 -m comment --comment "vm0:runner:test-runner"`,
            stderr: "",
          };
        }
        if (cmd.includes("-D PREROUTING")) {
          deleteCallCount++;
          if (deleteCallCount === 1) {
            throw new Error("Rule already gone");
          }
        }
        return { stdout: "", stderr: "" };
      };

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await cleanupOrphanedProxyRules("test-runner");

      // Should attempt to delete both rules even if first fails
      expect(deleteCallCount).toBe(2);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to delete rule"),
      );
      consoleSpy.mockRestore();
    });
  });
});
