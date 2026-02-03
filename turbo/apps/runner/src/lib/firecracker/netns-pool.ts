/**
 * Network Namespace Pool for Firecracker Snapshot VMs
 *
 * Manages pre-warmed network namespaces to reduce VM startup time.
 * Each namespace provides complete network isolation with fixed IPs,
 * enabling snapshot-based VM cloning without IP conflicts.
 *
 * Network Architecture:
 * ```
 * ┌─────────────────────┐  ┌─────────────────────┐
 * │     Namespace 1     │  │     Namespace 2     │
 * │ ┌─────────────────┐ │  │ ┌─────────────────┐ │
 * │ │       VM        │ │  │ │       VM        │ │
 * │ │  192.168.241.2  │ │  │ │  192.168.241.2  │ │  ← Same fixed IP
 * │ └────────┬────────┘ │  │ └────────┬────────┘ │
 * │          │ TAP      │  │          │ TAP      │
 * │    192.168.241.1    │  │    192.168.241.1    │
 * │          │          │  │          │          │
 * │      NAT/MASQ       │  │      NAT/MASQ       │
 * │          │ veth0    │  │          │ veth0    │
 * │      10.200.0.2     │  │      10.200.0.6     │  ← Unique veth IP
 * └──────────┼──────────┘  └──────────┼──────────┘
 *            │ veth-host              │ veth-host
 *        10.200.0.1               10.200.0.5
 *            │                        │
 *            └──────────┬─────────────┘
 *                       │ NAT/MASQ
 *                       ↓
 *                 External Network
 * ```
 *
 * Design:
 * - Pool creates fixed number of namespaces at init (parallel)
 * - acquire() returns a namespace from pool, or creates on-demand as fallback
 * - release() returns the namespace to the pool
 * - Multi-runner coordination via file-based registry with PID tracking
 */

import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { createLogger } from "../logger.js";
import { withFileLock } from "../utils/file-lock.js";
import { runtimePaths } from "../paths.js";
import { execCommand } from "../utils/exec.js";
import { createNetnsWithTap, SNAPSHOT_NETWORK } from "./netns.js";

const logger = createLogger("NetnsPool");

/** Internal constants for namespace/veth naming and IP allocation */
const VETH_NS = "veth0";
const NS_PREFIX = "vm0-ns-";
const VETH_PREFIX = "vm0-ve-";
const VETH_IP_PREFIX = "10.200";

/**
 * Capacity limits:
 * - Max runners: 64 (index 0x00-0x3f)
 * - Max namespaces per runner: 256 (index 0x00-0xff)
 * - Total namespaces: 64 * 256 = 16384
 *
 * Naming format (12 chars, under 15 char Linux limit):
 * - Namespace: vm0-ns-{runnerIdx:2hex}-{nsIdx:2hex}
 * - Veth host: vm0-ve-{runnerIdx:2hex}-{nsIdx:2hex}
 *
 * IP allocation (VETH_IP_PREFIX.{octet3}.{octet4}/30):
 * - octet3 = runnerIdx * 4 + floor(nsIdx / 64)
 * - octet4 = (nsIdx % 64) * 4 + 1 (host) or + 2 (ns)
 */
const MAX_RUNNERS = 64;
const MAX_NAMESPACES_PER_RUNNER = 256;

const NamespaceEntrySchema = z.object({
  vethHost: z.string(),
  hostIp: z.string(),
  nsIp: z.string(),
});

const RunnerEntrySchema = z.object({
  name: z.string(),
  pid: z.number(),
  namespaces: z.record(z.string(), NamespaceEntrySchema),
});

const RegistrySchema = z.object({
  runners: z.record(z.string(), RunnerEntrySchema),
});

type Registry = z.infer<typeof RegistrySchema>;

// ============ RegistryFile Class ============

/**
 * Handles file I/O operations for the namespace registry with proper locking.
 * Read/write operations are only available within the withLock callback.
 */
class RegistryFile {
  constructor(private readonly filePath: string) {}

  /** Ensure directory and file exist (atomic creation) */
  ensureExists(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.filePath)) {
      try {
        writeFileSync(this.filePath, JSON.stringify({ runners: {} }), {
          flag: "wx",
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
      }
    }
  }

  /** Execute function while holding file lock, providing read/write operations */
  async withLock<T>(
    fn: (
      read: () => Registry,
      write: (registry: Registry) => void,
    ) => Promise<T>,
  ): Promise<T> {
    return withFileLock(this.filePath, () => {
      const read = (): Registry => {
        try {
          if (existsSync(this.filePath)) {
            const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
            return RegistrySchema.parse(data);
          }
        } catch {
          // Ignore parse errors, return empty registry
        }
        return { runners: {} };
      };

      const write = (registry: Registry): void => {
        writeFileSync(this.filePath, JSON.stringify(registry, null, 2));
      };

      return fn(read, write);
    });
  }
}

// ============ Types ============

/**
 * Pooled namespace resource
 */
export interface PooledNetns {
  /** Namespace name */
  name: string;
  /** Host-side veth device name */
  vethHost: string;
  /** Host-side veth IP */
  vethHostIp: string;
  /** Namespace-side veth IP (used for VM registry) */
  vethNsIp: string;
  /** Fixed guest IP (baked into snapshot) */
  guestIp: string;
  /** Fixed TAP IP (gateway for guest) */
  tapIp: string;
}

/**
 * Pool configuration
 */
export interface NetnsPoolConfig {
  /** Runner name for generating unique namespace prefix */
  name: string;
  /** Number of namespaces to pre-create */
  size: number;
  /** Proxy port for HTTP/HTTPS redirect (optional) */
  proxyPort?: number;
  /** Registry file path for testing (default: runtimePaths.netnsRegistry) */
  registryFile?: string;
}

// ============ Helper Functions ============

async function getDefaultInterface(): Promise<string> {
  const result = await execCommand("ip route get 8.8.8.8", false);
  const match = result.match(/dev\s+(\S+)/);
  if (match && match[1]) {
    return match[1];
  }
  throw new Error(`Failed to detect default network interface from: ${result}`);
}

function formatHexIndex(index: number): string {
  return index.toString(16).padStart(2, "0");
}

function makeNsName(runnerIdx: string, nsIdx: string): string {
  return `${NS_PREFIX}${runnerIdx}-${nsIdx}`;
}

function makeVethName(runnerIdx: string, nsIdx: string): string {
  return `${VETH_PREFIX}${runnerIdx}-${nsIdx}`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function deleteIptablesRulesByComment(comment: string): Promise<void> {
  const deleteFromTable = async (table: string) => {
    try {
      const rules = await execCommand(
        `iptables-save -t ${table} | grep -F -- "${comment}" || true`,
        true,
      );
      const deleteCommands = rules
        .split("\n")
        .filter((rule) => rule.startsWith("-A "))
        .map((rule) => rule.replace(/^-A /, "-D "));

      await Promise.all(
        deleteCommands.map((deleteRule) =>
          execCommand(`iptables -t ${table} ${deleteRule}`).catch(() => {}),
        ),
      );
    } catch {
      // Ignore errors
    }
  };

  await Promise.all([deleteFromTable("nat"), deleteFromTable("filter")]);
}

// ============ NetnsPool Class ============

export class NetnsPool {
  private active = true;
  private queue: PooledNetns[] = [];
  private nextNsIndex = 0;
  private readonly runnerIndex: string;
  private readonly registry: RegistryFile;
  private readonly proxyPort?: number;
  private defaultInterfacePromise: Promise<string> | null = null;

  private constructor(
    proxyPort: number | undefined,
    registry: RegistryFile,
    runnerIndex: string,
  ) {
    this.proxyPort = proxyPort;
    this.registry = registry;
    this.runnerIndex = runnerIndex;
  }

  static async create(config: NetnsPoolConfig): Promise<NetnsPool> {
    const registry = new RegistryFile(
      config.registryFile ?? runtimePaths.netnsRegistry,
    );

    logger.log(`Initializing namespace pool (size=${config.size})...`);

    // Run these in parallel: enable IP forwarding, cleanup orphans
    const [, runnerIndex] = await Promise.all([
      execCommand("sysctl -w net.ipv4.ip_forward=1").then(() => {
        logger.log("Host IP forwarding enabled");
      }),
      NetnsPool.cleanupOrphanedAndAllocate(registry, config.name),
    ]);

    logger.log(`Runner index allocated: ${runnerIndex}`);

    const pool = new NetnsPool(config.proxyPort, registry, runnerIndex);

    // Create all namespaces in parallel
    if (config.size > 0) {
      const results = await Promise.all(
        Array.from({ length: config.size }, () =>
          pool.createNamespace().catch((err) => {
            logger.error(
              `Failed to create namespace: ${err instanceof Error ? err.message : "Unknown"}`,
            );
            return null;
          }),
        ),
      );
      pool.queue = results.filter((ns): ns is PooledNetns => ns !== null);
    }

    logger.log(`Namespace pool initialized: ${pool.queue.length} available`);
    return pool;
  }

  private static async cleanupOrphanedAndAllocate(
    registry: RegistryFile,
    runnerName: string,
  ): Promise<string> {
    registry.ensureExists();

    // First pass: find orphaned runners
    const orphanedData = await registry.withLock(async (read) => {
      const data = read();
      const orphaned: {
        runnerIdx: string;
        namespaces: { nsIdx: string; vethHost: string }[];
      }[] = [];

      for (const [runnerIdx, runner] of Object.entries(data.runners)) {
        if (!isPidAlive(runner.pid)) {
          orphaned.push({
            runnerIdx,
            namespaces: Object.entries(runner.namespaces).map(
              ([nsIdx, ns]) => ({
                nsIdx,
                vethHost: ns.vethHost,
              }),
            ),
          });
        }
      }
      return orphaned;
    });

    // Execute cleanup without holding the lock
    if (orphanedData.length > 0) {
      logger.log(`Cleaning up ${orphanedData.length} orphaned runner(s)`);
      await Promise.all(
        orphanedData.map(async ({ runnerIdx, namespaces }) => {
          await Promise.all(
            namespaces.map(async ({ nsIdx, vethHost }) => {
              const nsName = makeNsName(runnerIdx, nsIdx);
              await deleteIptablesRulesByComment(nsName);
              await Promise.all([
                execCommand(`ip link del ${vethHost}`).catch(() => {}),
                execCommand(`ip netns del ${nsName}`).catch(() => {}),
              ]);
            }),
          );
        }),
      );
    }

    // Second pass: remove orphans (re-check PID) and allocate new runner index
    return registry.withLock(async (read, write) => {
      const data = read();

      // Re-check and remove orphaned entries (PID might have been reused)
      for (const { runnerIdx } of orphanedData) {
        const runner = data.runners[runnerIdx];
        if (runner && !isPidAlive(runner.pid)) {
          delete data.runners[runnerIdx];
        }
      }

      // Allocate new runner index
      const usedIndices = new Set(
        Object.keys(data.runners).map((i) => parseInt(i, 16)),
      );
      let index = 0;
      while (usedIndices.has(index) && index < MAX_RUNNERS) index++;
      if (index >= MAX_RUNNERS) {
        throw new Error(
          `Runner limit reached: max ${MAX_RUNNERS} runners allowed`,
        );
      }
      const indexStr = formatHexIndex(index);

      data.runners[indexStr] = {
        name: runnerName,
        pid: process.pid,
        namespaces: {},
      };
      write(data);

      return indexStr;
    });
  }

  private async withRegistry<T>(fn: (data: Registry) => T): Promise<T> {
    return this.registry.withLock(async (read, write) => {
      const data = read();
      const result = fn(data);
      write(data);
      return result;
    });
  }

  private isOwnNamespace(name: string): boolean {
    return name.startsWith(`${NS_PREFIX}${this.runnerIndex}-`);
  }

  /** Parse namespace name into runner and namespace indices */
  private parseNsName(
    name: string,
  ): { runnerIdx: string; nsIdx: string } | null {
    if (!name.startsWith(NS_PREFIX)) {
      return null;
    }
    const parts = name.slice(NS_PREFIX.length).split("-");
    if (parts[0] && parts[1]) {
      return { runnerIdx: parts[0], nsIdx: parts[1] };
    }
    return null;
  }

  /** Generate IP pair from runner and namespace indices (see capacity limits above) */
  private generateVethIpPair(
    runnerIdx: number,
    nsIdx: number,
  ): { hostIp: string; nsIp: string } {
    const octet3 = runnerIdx * 4 + Math.floor(nsIdx / 64);
    const octet4Base = (nsIdx % 64) * 4;

    return {
      hostIp: `${VETH_IP_PREFIX}.${octet3}.${octet4Base + 1}`,
      nsIp: `${VETH_IP_PREFIX}.${octet3}.${octet4Base + 2}`,
    };
  }

  private getDefaultInterface(): Promise<string> {
    if (!this.defaultInterfacePromise) {
      this.defaultInterfacePromise = getDefaultInterface().catch((err) => {
        this.defaultInterfacePromise = null; // Clear cache on failure
        throw err;
      });
    }
    return this.defaultInterfacePromise;
  }

  private async createNamespace(): Promise<PooledNetns> {
    if (this.nextNsIndex >= MAX_NAMESPACES_PER_RUNNER) {
      throw new Error(
        `Namespace limit reached: max ${MAX_NAMESPACES_PER_RUNNER} namespaces per runner`,
      );
    }
    const nsIndex = this.nextNsIndex++;
    const nsIndexStr = formatHexIndex(nsIndex);
    const name = makeNsName(this.runnerIndex, nsIndexStr);
    const vethHost = makeVethName(this.runnerIndex, nsIndexStr);
    const runnerIdx = parseInt(this.runnerIndex, 16);
    const { hostIp: vethHostIp, nsIp: vethNsIp } = this.generateVethIpPair(
      runnerIdx,
      nsIndex,
    );

    // Register in registry with file lock
    await this.withRegistry((data) => {
      const runner = data.runners[this.runnerIndex];
      if (!runner) {
        throw new Error(`Runner ${this.runnerIndex} not found in registry`);
      }
      runner.namespaces[nsIndexStr] = {
        vethHost,
        hostIp: vethHostIp,
        nsIp: vethNsIp,
      };
    });

    logger.log(`Creating namespace ${name}...`);

    try {
      // Create namespace with TAP device (shared with snapshot command)
      await createNetnsWithTap(name, {
        tapName: SNAPSHOT_NETWORK.tapName,
        gatewayIpWithPrefix: `${SNAPSHOT_NETWORK.gatewayIp}/${SNAPSHOT_NETWORK.prefixLen}`,
      });

      // Add veth pair for external connectivity
      await execCommand(
        `ip link add ${vethHost} type veth peer name ${VETH_NS} netns ${name}`,
      );
      await execCommand(
        `ip netns exec ${name} ip addr add ${vethNsIp}/30 dev ${VETH_NS}`,
      );
      await execCommand(`ip netns exec ${name} ip link set ${VETH_NS} up`);
      await execCommand(`ip addr add ${vethHostIp}/30 dev ${vethHost}`);
      await execCommand(`ip link set ${vethHost} up`);

      // Configure routing and NAT
      await execCommand(
        `ip netns exec ${name} ip route add default via ${vethHostIp}`,
      );
      await execCommand(
        `ip netns exec ${name} iptables -t nat -A POSTROUTING -s ${SNAPSHOT_NETWORK.gatewayIp}/${SNAPSHOT_NETWORK.prefixLen} -o ${VETH_NS} -j MASQUERADE`,
      );
      await execCommand(
        `ip netns exec ${name} sysctl -w net.ipv4.ip_forward=1`,
      );

      // Host iptables rules can be executed in parallel (independent of each other)
      const defaultIface = await this.getDefaultInterface();
      const iptablesRules = [
        `iptables -t nat -A POSTROUTING -s ${vethNsIp}/30 -o ${defaultIface} -j MASQUERADE -m comment --comment "${name}"`,
        `iptables -A FORWARD -i ${vethHost} -o ${defaultIface} -j ACCEPT -m comment --comment "${name}"`,
        `iptables -A FORWARD -i ${defaultIface} -o ${vethHost} -m state --state RELATED,ESTABLISHED -j ACCEPT -m comment --comment "${name}"`,
      ];

      if (this.proxyPort) {
        iptablesRules.push(
          `iptables -t nat -A PREROUTING -s ${vethNsIp}/30 -p tcp --dport 80 -j REDIRECT --to-port ${this.proxyPort} -m comment --comment "${name}"`,
          `iptables -t nat -A PREROUTING -s ${vethNsIp}/30 -p tcp --dport 443 -j REDIRECT --to-port ${this.proxyPort} -m comment --comment "${name}"`,
        );
      }

      await Promise.all(iptablesRules.map((rule) => execCommand(rule)));

      logger.log(`Namespace ${name} created`);

      return {
        name,
        vethHost,
        vethHostIp,
        vethNsIp,
        guestIp: SNAPSHOT_NETWORK.guestIp,
        tapIp: SNAPSHOT_NETWORK.gatewayIp,
      };
    } catch (err) {
      logger.error(`Failed to create namespace ${name}, cleaning up...`);
      // Remove from registry
      await this.withRegistry((data) => {
        const runner = data.runners[this.runnerIndex];
        if (runner) {
          delete runner.namespaces[nsIndexStr];
        }
      });
      await deleteIptablesRulesByComment(name);
      await Promise.all([
        execCommand(`ip link del ${vethHost}`).catch(() => {}),
        execCommand(`ip netns del ${name}`).catch(() => {}),
      ]);
      throw err;
    }
  }

  private async deleteNamespace(
    ns: PooledNetns,
    updateRegistry = true,
  ): Promise<void> {
    logger.log(`Deleting namespace ${ns.name}...`);
    await deleteIptablesRulesByComment(ns.name);
    await Promise.all([
      execCommand(`ip link del ${ns.vethHost}`).catch(() => {}),
      execCommand(`ip netns del ${ns.name}`).catch(() => {}),
    ]);

    // Only update registry for own namespaces to avoid modifying other runners' entries
    if (updateRegistry) {
      const parsed = this.parseNsName(ns.name);
      if (parsed && parsed.runnerIdx === this.runnerIndex) {
        await this.withRegistry((data) => {
          const runner = data.runners[parsed.runnerIdx];
          if (runner?.namespaces[parsed.nsIdx]) {
            delete runner.namespaces[parsed.nsIdx];
          }
        });
      }
    }

    logger.log(`Namespace ${ns.name} deleted`);
  }

  async acquire(): Promise<PooledNetns> {
    const pooled = this.queue.shift();
    if (pooled) {
      logger.log(
        `Acquired namespace: ${pooled.name} (${this.queue.length} remaining)`,
      );
      return pooled;
    }

    // Fallback: create on-demand
    logger.log("Pool exhausted, creating namespace on-demand");
    return this.createNamespace();
  }

  async release(ns: PooledNetns): Promise<void> {
    if (!this.active) {
      await this.deleteNamespace(ns);
      return;
    }

    if (this.isOwnNamespace(ns.name)) {
      if (this.queue.some((r) => r.name === ns.name)) {
        logger.log(`Namespace ${ns.name} already in pool, ignoring`);
        return;
      }
      this.queue.push(ns);
      logger.log(
        `Namespace released: ${ns.name} (${this.queue.length} available)`,
      );
    } else {
      await this.deleteNamespace(ns);
    }
  }

  async cleanup(): Promise<void> {
    if (!this.active) {
      return;
    }

    this.active = false;
    logger.log(
      `Cleaning up namespace pool (${this.queue.length} namespaces)...`,
    );

    const toDelete = [...this.queue];
    this.queue = [];

    // Delete namespaces without individual registry updates
    await Promise.all(
      toDelete.map((ns) =>
        this.deleteNamespace(ns, false).catch((err) => {
          logger.error(
            `Failed to delete ${ns.name}: ${err instanceof Error ? err.message : "Unknown"}`,
          );
        }),
      ),
    );

    // Batch remove all namespace entries and runner entry from registry
    await this.withRegistry((data) => {
      delete data.runners[this.runnerIndex];
    });

    this.defaultInterfacePromise = null;
    logger.log("Namespace pool cleanup complete");
  }

  getAvailableCount(): number {
    return this.queue.length;
  }
}

// ============ Module-level Pool Instance ============

let pool: NetnsPool | null = null;

export async function initNetnsPool(config: NetnsPoolConfig): Promise<void> {
  if (pool) {
    await pool.cleanup();
  }
  pool = await NetnsPool.create(config);
}

export async function acquireNetns(): Promise<PooledNetns> {
  if (!pool) {
    throw new Error("Namespace pool not initialized");
  }
  return pool.acquire();
}

export async function releaseNetns(ns: PooledNetns): Promise<void> {
  if (!pool) {
    throw new Error("Namespace pool not initialized");
  }
  return pool.release(ns);
}

export async function cleanupNetnsPool(): Promise<void> {
  if (pool) {
    await pool.cleanup();
    pool = null;
  }
}
