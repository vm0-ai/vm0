/**
 * Firecracker VM Lifecycle Manager
 *
 * Manages the complete lifecycle of a Firecracker microVM:
 * - Process management (spawn, terminate)
 * - Configuration via JSON config file or API socket
 * - Network setup via network namespace pool
 * - Boot from config or snapshot restoration
 *
 * Two modes of operation:
 * 1. Fresh boot: --config-file --no-api (fast, no API overhead)
 * 2. Snapshot: --api-sock (required for snapshot loading via API)
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { acquireNetns, releaseNetns, type PooledNetns } from "./netns-pool.js";
import { SNAPSHOT_NETWORK, generateSnapshotNetworkBootArgs } from "./netns.js";
import { acquireOverlay } from "./overlay-pool.js";
import { FirecrackerClient } from "./client.js";
import { createLogger } from "../logger.js";
import { vmPaths } from "../paths.js";
import type { VmId } from "./vm-id.js";

/**
 * Firecracker static configuration format
 * See: https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md
 */
interface FirecrackerConfig {
  "boot-source": {
    kernel_image_path: string;
    boot_args: string;
  };
  drives: Array<{
    drive_id: string;
    path_on_host: string;
    is_root_device: boolean;
    is_read_only: boolean;
  }>;
  "machine-config": {
    vcpu_count: number;
    mem_size_mib: number;
  };
  "network-interfaces": Array<{
    iface_id: string;
    guest_mac: string;
    host_dev_name: string;
  }>;
  vsock: {
    guest_cid: number;
    uds_path: string;
  };
}

const logger = createLogger("VM");

/**
 * Snapshot paths for restoring a VM from snapshot
 */
export interface SnapshotPaths {
  /** Path to the snapshot state file */
  snapshotPath: string;
  /** Path to the memory file */
  memoryPath: string;
}

/**
 * VM configuration options
 */
export interface VMConfig {
  vmId: VmId;
  vcpus: number;
  memoryMb: number;
  kernelPath: string;
  rootfsPath: string;
  firecrackerBinary: string;
  workDir: string; // Working directory for VM files
}

/**
 * VM state
 */
type VMState =
  | "created"
  | "configuring"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

/**
 * Firecracker VM instance
 */
export class FirecrackerVM {
  private config: VMConfig;
  private process: ChildProcess | null = null;
  private netns: PooledNetns | null = null;
  private state: VMState = "created";
  private workDir: string;
  private vmOverlayPath: string | null = null; // Set during start()
  private vsockPath: string; // Vsock UDS path for host-guest communication
  private configPath: string; // Firecracker config file path
  private apiSocketPath: string; // API socket path for snapshot mode

  constructor(config: VMConfig) {
    this.config = config;
    this.workDir = config.workDir;
    this.vsockPath = vmPaths.vsock(this.workDir);
    this.configPath = vmPaths.config(this.workDir);
    this.apiSocketPath = `${this.workDir}/api.sock`;
  }

  /**
   * Get current VM state
   */
  getState(): VMState {
    return this.state;
  }

  /**
   * Get the VM's IP address (once started)
   * Returns the fixed guest IP from SNAPSHOT_NETWORK
   */
  getGuestIp(): string | null {
    return this.netns ? SNAPSHOT_NETWORK.guestIp : null;
  }

  /**
   * Get the VM's network namespace
   */
  getNetns(): PooledNetns | null {
    return this.netns;
  }

  /**
   * Get the vsock UDS path for host-guest communication
   */
  getVsockPath(): string {
    return this.vsockPath;
  }

  /**
   * Start the VM
   *
   * Two modes:
   * 1. Fresh boot (fromSnapshot undefined):
   *    Uses --config-file --no-api for fastest startup
   * 2. Snapshot restore (fromSnapshot provided):
   *    Uses --api-sock to load snapshot via API
   *
   * @param fromSnapshot Optional snapshot paths to restore from
   */
  async start(fromSnapshot?: SnapshotPaths): Promise<void> {
    if (this.state !== "created") {
      throw new Error(`Cannot start VM in state: ${this.state}`);
    }

    try {
      // Create working directory and vsock subdirectory
      fs.mkdirSync(this.workDir, { recursive: true });
      fs.mkdirSync(vmPaths.vsockDir(this.workDir), { recursive: true });

      // Acquire overlay and namespace in parallel for faster startup
      // Both pools are pre-warmed, so acquisition should be near-instant
      // Use allSettled to handle partial failures and avoid resource leaks
      logger.log(`[VM ${this.config.vmId}] Acquiring resources...`);
      const results = await Promise.allSettled([
        acquireOverlay(),
        acquireNetns(),
      ]);

      const [overlayResult, netnsResult] = results;

      // Handle failures - clean up any successfully acquired resources before throwing
      if (overlayResult.status === "rejected") {
        // Overlay failed - clean up netns if it succeeded
        if (netnsResult.status === "fulfilled") {
          await releaseNetns(netnsResult.value).catch(() => {});
        }
        throw overlayResult.reason;
      }

      if (netnsResult.status === "rejected") {
        // Netns failed - clean up overlay if it succeeded
        if (fs.existsSync(overlayResult.value)) {
          fs.unlinkSync(overlayResult.value);
        }
        throw netnsResult.reason;
      }

      // Both succeeded
      this.vmOverlayPath = overlayResult.value;
      this.netns = netnsResult.value;
      logger.log(
        `[VM ${this.config.vmId}] Resources acquired: overlay + namespace ${this.netns.name}`,
      );

      // Log configuration summary
      logger.log(
        `[VM ${this.config.vmId}] Configuring: ${this.config.vcpus} vCPUs, ${this.config.memoryMb}MB RAM`,
      );
      logger.log(
        `[VM ${this.config.vmId}] Base rootfs: ${this.config.rootfsPath}`,
      );
      logger.log(`[VM ${this.config.vmId}] Overlay: ${this.vmOverlayPath}`);
      logger.log(`[VM ${this.config.vmId}] Namespace: ${this.netns.name}`);
      logger.log(`[VM ${this.config.vmId}] Vsock: ${this.vsockPath}`);

      if (fromSnapshot) {
        await this.startFromSnapshot(fromSnapshot);
      } else {
        await this.startFresh();
      }

      this.state = "running";
      logger.log(
        `[VM ${this.config.vmId}] Running at ${SNAPSHOT_NETWORK.guestIp}`,
      );
    } catch (error) {
      this.state = "error";
      // Cleanup on failure
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Start VM fresh from config file
   * Uses --config-file --no-api for fastest startup
   */
  private async startFresh(): Promise<void> {
    // Build and write Firecracker config file
    const config = this.buildConfig();
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));

    logger.log(`[VM ${this.config.vmId}] Starting Firecracker (fresh boot)...`);

    // Run Firecracker inside the network namespace
    this.process = spawn(
      "sudo",
      [
        "ip",
        "netns",
        "exec",
        this.netns!.name,
        this.config.firecrackerBinary,
        "--config-file",
        this.configPath,
        "--no-api",
      ],
      {
        cwd: this.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      },
    );

    this.setupProcessHandlers();
  }

  /**
   * Start VM from snapshot
   * Uses --api-sock to load snapshot via API
   *
   * Drive configuration must be done before loading snapshot
   * because our overlay path differs from the snapshot's original path.
   */
  private async startFromSnapshot(snapshot: SnapshotPaths): Promise<void> {
    logger.log(
      `[VM ${this.config.vmId}] Starting Firecracker (snapshot restore)...`,
    );
    logger.log(`[VM ${this.config.vmId}] Snapshot: ${snapshot.snapshotPath}`);
    logger.log(`[VM ${this.config.vmId}] Memory: ${snapshot.memoryPath}`);

    // Run Firecracker with API socket inside the network namespace
    this.process = spawn(
      "sudo",
      [
        "ip",
        "netns",
        "exec",
        this.netns!.name,
        this.config.firecrackerBinary,
        "--api-sock",
        this.apiSocketPath,
      ],
      {
        cwd: this.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      },
    );

    this.setupProcessHandlers();

    // Wait for API to be ready, but fail fast if process exits
    const client = new FirecrackerClient(this.apiSocketPath);
    await this.waitForApiReady(client);

    // Configure drives before loading snapshot (parallel for performance)
    // Paths differ from snapshot's original paths, so we must reconfigure
    logger.log(`[VM ${this.config.vmId}] Configuring drives...`);
    await Promise.all([
      client.configureDrive({
        drive_id: "rootfs",
        path_on_host: this.config.rootfsPath,
        is_root_device: true,
        is_read_only: true,
      }),
      client.configureDrive({
        drive_id: "overlay",
        path_on_host: this.vmOverlayPath!,
        is_root_device: false,
        is_read_only: false,
      }),
    ]);

    // Load snapshot and resume
    logger.log(`[VM ${this.config.vmId}] Loading snapshot...`);
    await client.loadSnapshot({
      snapshot_path: snapshot.snapshotPath,
      mem_backend: {
        backend_path: snapshot.memoryPath,
        backend_type: "File",
      },
      resume_vm: true,
    });
    logger.log(`[VM ${this.config.vmId}] Snapshot loaded and resumed`);
  }

  /**
   * Set up process event handlers for stdout/stderr logging
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    // Handle process errors
    this.process.on("error", (err) => {
      logger.log(`[VM ${this.config.vmId}] Firecracker error: ${err}`);
      this.state = "error";
    });

    this.process.on("exit", (code, signal) => {
      logger.log(
        `[VM ${this.config.vmId}] Firecracker exited: code=${code}, signal=${signal}`,
      );
      if (this.state !== "stopped") {
        this.state = "stopped";
      }
    });

    // Log stdout/stderr line by line (prevents fragmented output)
    if (this.process.stdout) {
      const stdoutRL = readline.createInterface({
        input: this.process.stdout,
      });
      stdoutRL.on("line", (line) => {
        // Only log non-empty kernel boot messages at debug level
        if (line.trim()) {
          logger.log(`[VM ${this.config.vmId}] ${line}`);
        }
      });
    }
    if (this.process.stderr) {
      const stderrRL = readline.createInterface({
        input: this.process.stderr,
      });
      stderrRL.on("line", (line) => {
        if (line.trim()) {
          logger.log(`[VM ${this.config.vmId}] stderr: ${line}`);
        }
      });
    }
  }

  /**
   * Build Firecracker configuration object
   *
   * Creates the JSON configuration for Firecracker's --config-file option.
   * Boot args:
   *   - console=ttyS0: serial console output
   *   - reboot=k: use keyboard controller for reboot
   *   - panic=1: reboot after 1 second on kernel panic
   *   - pci=off: disable PCI bus (not needed in microVM)
   *   - nomodules: skip module loading (not needed in microVM)
   *   - random.trust_cpu=on: trust CPU RNG, skip entropy wait
   *   - quiet loglevel=0: minimize kernel log output
   *   - nokaslr: disable kernel address space randomization
   *   - audit=0: disable kernel auditing
   *   - numa=off: disable NUMA (single node)
   *   - mitigations=off: disable CPU vulnerability mitigations
   *   - noresume: skip hibernation resume check
   *   - init=/sbin/vm-init: use vm-init (Rust binary) for filesystem setup and vsock-agent
   *   - ip=...: network configuration (fixed IPs from SNAPSHOT_NETWORK)
   */
  private buildConfig(): FirecrackerConfig {
    if (!this.netns || !this.vmOverlayPath) {
      throw new Error("VM not properly initialized");
    }

    // Use fixed network boot args for snapshot compatibility
    const networkBootArgs = generateSnapshotNetworkBootArgs();
    const bootArgs = `console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on quiet loglevel=0 nokaslr audit=0 numa=off mitigations=off noresume init=/sbin/vm-init ${networkBootArgs}`;

    logger.log(`[VM ${this.config.vmId}] Boot args: ${bootArgs}`);

    return {
      "boot-source": {
        kernel_image_path: this.config.kernelPath,
        boot_args: bootArgs,
      },
      drives: [
        // Base drive (squashfs, read-only, shared across VMs)
        // Mounted as /dev/vda inside the VM
        {
          drive_id: "rootfs",
          path_on_host: this.config.rootfsPath,
          is_root_device: true,
          is_read_only: true,
        },
        // Overlay drive (ext4, read-write, per-VM)
        // Mounted as /dev/vdb inside the VM
        // The vm-init script combines these using overlayfs
        {
          drive_id: "overlay",
          path_on_host: this.vmOverlayPath,
          is_root_device: false,
          is_read_only: false,
        },
      ],
      "machine-config": {
        vcpu_count: this.config.vcpus,
        mem_size_mib: this.config.memoryMb,
      },
      "network-interfaces": [
        {
          // Network interface uses fixed config from SNAPSHOT_NETWORK
          // TAP device is inside the namespace, created by netns-pool
          iface_id: "eth0",
          guest_mac: SNAPSHOT_NETWORK.guestMac,
          host_dev_name: SNAPSHOT_NETWORK.tapName,
        },
      ],
      // Guest CID 3 is the standard guest identifier (CID 0=hypervisor, 1=local, 2=host)
      vsock: {
        guest_cid: 3,
        uds_path: this.vsockPath,
      },
    };
  }

  /**
   * Stop the VM
   *
   * Note: With --no-api mode, we force kill the Firecracker process.
   * Graceful shutdown (filesystem sync) should be done via vsock
   * before calling this method.
   */
  async stop(): Promise<void> {
    if (this.state !== "running") {
      logger.log(`[VM ${this.config.vmId}] Not running, state: ${this.state}`);
      return;
    }

    this.state = "stopping";
    logger.log(`[VM ${this.config.vmId}] Stopping...`);
    await this.cleanup();
  }

  /**
   * Force kill the VM
   */
  async kill(): Promise<void> {
    logger.log(`[VM ${this.config.vmId}] Force killing...`);
    await this.cleanup();
  }

  /**
   * Cleanup VM resources
   * Note: Cleanup logs warnings but continues if individual cleanup steps fail,
   * since we want to clean up as much as possible even if some parts fail.
   */
  private async cleanup(): Promise<void> {
    // Kill Firecracker process
    if (this.process && !this.process.killed) {
      this.process.kill("SIGKILL");
      this.process = null;
    }

    // Release network namespace back to pool
    if (this.netns) {
      try {
        await releaseNetns(this.netns);
      } catch (err) {
        logger.log(
          `[VM ${this.config.vmId}] Failed to release namespace: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      }
      this.netns = null;
    }

    // Delete overlay file (from pool, not in workDir)
    if (this.vmOverlayPath) {
      try {
        if (fs.existsSync(this.vmOverlayPath)) {
          fs.unlinkSync(this.vmOverlayPath);
        }
      } catch (err) {
        logger.log(
          `[VM ${this.config.vmId}] Failed to delete overlay: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      }
      this.vmOverlayPath = null;
    }

    // Clean up entire workDir (includes socket)
    try {
      if (fs.existsSync(this.workDir)) {
        fs.rmSync(this.workDir, { recursive: true, force: true });
      }
    } catch (err) {
      logger.log(
        `[VM ${this.config.vmId}] Failed to delete workDir: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    }

    this.state = "stopped";
    logger.log(`[VM ${this.config.vmId}] Stopped`);
  }

  /**
   * Wait for the VM process to exit
   * Returns the exit code
   */
  async waitForExit(timeoutMs: number = 60000): Promise<number> {
    if (!this.process) {
      return 0;
    }

    // Check if process already exited (exitCode is set)
    if (this.process.exitCode !== null) {
      return this.process.exitCode;
    }

    return new Promise((resolve, reject) => {
      const process = this.process!;

      const exitHandler = (code: number | null) => {
        clearTimeout(timeout);
        resolve(code ?? 0);
      };

      const timeout = setTimeout(() => {
        process.removeListener("exit", exitHandler);
        reject(new Error(`VM did not exit within ${timeoutMs}ms`));
      }, timeoutMs);

      process.once("exit", exitHandler);
    });
  }

  /**
   * Check if the VM is running
   */
  isRunning(): boolean {
    return (
      this.state === "running" && this.process !== null && !this.process.killed
    );
  }

  /**
   * Wait for API to be ready, but fail fast if process exits
   *
   * This prevents waiting for timeout if Firecracker crashes immediately.
   */
  private async waitForApiReady(client: FirecrackerClient): Promise<void> {
    if (!this.process) {
      throw new Error("Firecracker process not started");
    }

    // Check if already exited
    if (this.process.exitCode !== null) {
      throw new Error(
        `Firecracker process exited immediately with code ${this.process.exitCode}`,
      );
    }

    // Create exit handler that we can remove later
    let exitHandler:
      | ((code: number | null, signal: string | null) => void)
      | null = null;

    const processExitPromise = new Promise<never>((_, reject) => {
      exitHandler = (code, signal) => {
        reject(
          new Error(
            `Firecracker process exited during startup: code=${code}, signal=${signal}`,
          ),
        );
      };
      this.process!.once("exit", exitHandler);
    });

    try {
      // Race between API ready and process exit
      await Promise.race([client.waitForReady(), processExitPromise]);
    } finally {
      // Clean up the exit listener to avoid memory leak
      if (exitHandler && this.process) {
        this.process.removeListener("exit", exitHandler);
      }
    }
  }
}
