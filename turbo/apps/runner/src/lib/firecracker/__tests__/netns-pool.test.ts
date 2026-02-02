import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NetnsPool,
  type PooledNetns,
  type NetnsPoolConfig,
} from "../netns-pool.js";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

import { exec } from "node:child_process";

describe("NetnsPool", () => {
  let activePools: NetnsPool[] = [];
  let execCalls: string[] = [];
  let tempDir: string;
  let registryFile: string;

  const mockExec = vi.mocked(exec);

  function setupMockExec() {
    mockExec.mockImplementation((cmd: string, callback?: unknown) => {
      execCalls.push(cmd);

      let stdout = "";
      if (cmd.includes("ip route get 8.8.8.8")) {
        stdout = "8.8.8.8 via 10.0.0.1 dev eth0 src 10.0.0.2";
      } else if (cmd.includes("ip netns list")) {
        stdout = "";
      }

      if (typeof callback === "function") {
        (callback as (err: Error | null, result: { stdout: string }) => void)(
          null,
          { stdout },
        );
      }

      return {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      } as unknown as ReturnType<typeof exec>;
    });
  }

  async function createPool(
    config: Omit<NetnsPoolConfig, "registryFile">,
  ): Promise<NetnsPool> {
    const pool = await NetnsPool.create({ registryFile, ...config });
    activePools.push(pool);
    return pool;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    execCalls = [];
    activePools = [];
    tempDir = mkdtempSync(path.join(tmpdir(), "netns-pool-test-"));
    registryFile = path.join(tempDir, "netns-registry.json");
    setupMockExec();
  });

  afterEach(async () => {
    for (const pool of activePools) {
      await pool.cleanup();
    }
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("should create pool with config", async () => {
      const pool = await createPool({ name: "test-runner", size: 3 });
      expect(pool).toBeInstanceOf(NetnsPool);
      expect(pool.getAvailableCount()).toBe(3);
    });

    it("should enable IP forwarding on create", async () => {
      await createPool({ name: "test-runner", size: 0 });

      const ipForwardCall = execCalls.find((cmd) =>
        cmd.includes("net.ipv4.ip_forward=1"),
      );
      expect(ipForwardCall).toBeDefined();
    });

    it("should create namespaces in parallel up to pool size", async () => {
      const pool = await createPool({ name: "test-runner", size: 3 });

      const nsAddCalls = execCalls.filter((cmd) =>
        cmd.includes("ip netns add"),
      );
      expect(nsAddCalls).toHaveLength(3);
      expect(pool.getAvailableCount()).toBe(3);
    });

    it("should handle empty pool size", async () => {
      const pool = await createPool({ name: "test-runner", size: 0 });
      expect(pool.getAvailableCount()).toBe(0);
    });
  });

  describe("acquire", () => {
    it("should return namespace from pool", async () => {
      const pool = await createPool({ name: "test-runner", size: 2 });
      expect(pool.getAvailableCount()).toBe(2);

      const ns = await pool.acquire();

      expect(ns.name).toMatch(/^vm0-ns-[0-9a-f]{2}-[0-9a-f]{2}$/);
      expect(ns.vethHost).toMatch(/^vm0-ve-[0-9a-f]{2}-[0-9a-f]{2}$/);
      expect(ns.vethHostIp).toMatch(/^10\.\d+\.\d+\.\d+$/);
      expect(ns.vethNsIp).toMatch(/^10\.\d+\.\d+\.\d+$/);
      expect(ns.guestIp).toBe("192.168.241.2");
      expect(ns.tapIp).toBe("192.168.241.1");
      expect(pool.getAvailableCount()).toBe(1);
    });

    it("should create namespace on-demand when pool is exhausted", async () => {
      const pool = await createPool({ name: "test-runner", size: 1 });

      await pool.acquire();
      expect(pool.getAvailableCount()).toBe(0);

      execCalls = [];
      const ns = await pool.acquire();

      expect(ns.name).toBeDefined();
      const nsAddCalls = execCalls.filter((cmd) =>
        cmd.includes("ip netns add"),
      );
      expect(nsAddCalls).toHaveLength(1);
    });
  });

  describe("release", () => {
    it("should return namespace to pool", async () => {
      const pool = await createPool({ name: "test-runner", size: 1 });

      const ns = await pool.acquire();
      expect(pool.getAvailableCount()).toBe(0);

      await pool.release(ns);
      expect(pool.getAvailableCount()).toBe(1);
    });

    it("should make namespace available for next acquire", async () => {
      const pool = await createPool({ name: "test-runner", size: 1 });

      const ns1 = await pool.acquire();
      await pool.release(ns1);

      execCalls = [];
      const ns2 = await pool.acquire();

      const nsAddCalls = execCalls.filter((cmd) =>
        cmd.includes("ip netns add"),
      );
      expect(nsAddCalls).toHaveLength(0);
      expect(ns2.name).toBe(ns1.name);
    });

    it("should ignore duplicate release", async () => {
      const pool = await createPool({ name: "test-runner", size: 2 });

      const ns = await pool.acquire();
      await pool.release(ns);
      await pool.release(ns);

      expect(pool.getAvailableCount()).toBe(2);
    });

    it("should delete non-pooled namespace", async () => {
      const pool = await createPool({ name: "test-runner", size: 1 });

      const foreignNs: PooledNetns = {
        name: "v0n-foreign-00",
        vethHost: "v0e-foreign-00",
        vethHostIp: "10.1.2.1",
        vethNsIp: "10.1.2.2",
        guestIp: "192.168.241.2",
        tapIp: "192.168.241.1",
      };

      execCalls = [];
      await pool.release(foreignNs);

      const nsDelCalls = execCalls.filter((cmd) =>
        cmd.includes("ip netns del"),
      );
      expect(nsDelCalls.length).toBeGreaterThan(0);
    });
  });

  describe("cleanup", () => {
    it("should delete all namespaces in pool", async () => {
      const pool = await createPool({ name: "test-runner", size: 2 });
      expect(pool.getAvailableCount()).toBe(2);

      execCalls = [];
      await pool.cleanup();

      const nsDelCalls = execCalls.filter((cmd) =>
        cmd.includes("ip netns del"),
      );
      expect(nsDelCalls).toHaveLength(2);
      expect(pool.getAvailableCount()).toBe(0);
    });

    it("should handle cleanup when pool is empty", async () => {
      const pool = await createPool({ name: "test-runner", size: 0 });
      await expect(pool.cleanup()).resolves.not.toThrow();
    });

    it("should delete namespace when released after cleanup", async () => {
      const pool = await createPool({ name: "test-runner", size: 1 });
      const ns = await pool.acquire();

      await pool.cleanup();
      execCalls = [];

      await pool.release(ns);

      const nsDelCalls = execCalls.filter((cmd) =>
        cmd.includes("ip netns del"),
      );
      expect(nsDelCalls).toHaveLength(1);
    });
  });

  describe("namespace naming", () => {
    it("should generate unique namespace names", async () => {
      const pool = await createPool({ name: "test-runner", size: 3 });

      const ns1 = await pool.acquire();
      const ns2 = await pool.acquire();
      const ns3 = await pool.acquire();

      const names = [ns1.name, ns2.name, ns3.name];
      expect(new Set(names).size).toBe(3);
    });
  });

  describe("proxy configuration", () => {
    it("should add proxy rules when proxyPort is configured", async () => {
      await createPool({ name: "test-runner", size: 1, proxyPort: 8080 });

      const proxyRules = execCalls.filter(
        (cmd) =>
          cmd.includes("PREROUTING") &&
          cmd.includes("REDIRECT") &&
          cmd.includes("8080"),
      );
      expect(proxyRules.length).toBeGreaterThanOrEqual(2);
    });

    it("should not add proxy rules when proxyPort is not configured", async () => {
      await createPool({ name: "test-runner", size: 1 });

      const proxyRules = execCalls.filter(
        (cmd) => cmd.includes("PREROUTING") && cmd.includes("REDIRECT"),
      );
      expect(proxyRules).toHaveLength(0);
    });
  });

  describe("concurrent operations", () => {
    it("should handle concurrent acquires", async () => {
      const pool = await createPool({ name: "test-runner", size: 5 });

      const results = await Promise.all([
        pool.acquire(),
        pool.acquire(),
        pool.acquire(),
      ]);

      const names = results.map((r) => r.name);
      expect(new Set(names).size).toBe(3);
    });
  });
});
