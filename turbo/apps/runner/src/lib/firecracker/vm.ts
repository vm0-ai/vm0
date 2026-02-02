/**
 * Firecracker VM Lifecycle Manager
 *
 * Manages the complete lifecycle of a Firecracker microVM:
 * - Process management (spawn, terminate)
 * - Configuration via API
 * - Network setup
 * - Boot and shutdown
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { FirecrackerClient } from "./client.js";
import { generateNetworkBootArgs, type VMNetworkConfig } from "./network.js";
import { acquireOverlay } from "./overlay-pool.js";
import { acquireTap, releaseTap } from "./tap-pool.js";
import { createLogger } from "../logger.js";
import { tempPaths } from "../paths.js";

const logger = createLogger("VM");

/**
 * VM configuration options
 */
export interface VMConfig {
  vmId: string; // Unique identifier (e.g., first 8 chars of runId UUID)
  vcpus: number;
  memoryMb: number;
  kernelPath: string;
  rootfsPath: string;
  firecrackerBinary: string;
  workDir?: string; // Working directory for VM files (default: /tmp/vm0-vm-{vmId})
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
  private client: FirecrackerClient | null = null;
  private networkConfig: VMNetworkConfig | null = null;
  private state: VMState = "created";
  private workDir: string;
  private socketPath: string;
  private vmOverlayPath: string | null = null; // Set during start()
  private vsockPath: string; // Vsock UDS path for host-guest communication

  constructor(config: VMConfig) {
    this.config = config;
    this.workDir = config.workDir || tempPaths.vmWorkDir(config.vmId);
    this.socketPath = path.join(this.workDir, "firecracker.sock");
    this.vsockPath = path.join(this.workDir, "vsock.sock");
  }

  /**
   * Get current VM state
   */
  getState(): VMState {
    return this.state;
  }

  /**
   * Get the VM's IP address (once started)
   */
  getGuestIp(): string | null {
    return this.networkConfig?.guestIp || null;
  }

  /**
   * Get the VM's network configuration
   */
  getNetworkConfig(): VMNetworkConfig | null {
    return this.networkConfig;
  }

  /**
   * Get the socket path for Firecracker API
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Get the vsock UDS path for host-guest communication
   */
  getVsockPath(): string {
    return this.vsockPath;
  }

  /**
   * Start the VM
   * This spawns Firecracker, configures it via API, and boots the VM
   */
  async start(): Promise<void> {
    if (this.state !== "created") {
      throw new Error(`Cannot start VM in state: ${this.state}`);
    }

    try {
      // Create working directory
      fs.mkdirSync(this.workDir, { recursive: true });

      // Clean up any existing socket from previous runs
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }

      // Acquire overlay and TAP sequentially to ensure proper cleanup on failure
      // If overlay acquisition fails, TAP won't be acquired (no leak)
      // If TAP acquisition fails, overlay is already assigned and will be cleaned up

      // Acquire overlay from pre-warmed pool for faster boot
      // The base rootfs (squashfs) is shared read-only across all VMs
      // Each VM gets its own sparse ext4 overlay for writes (only allocates on write)
      // Falls back to on-demand creation if pool is exhausted
      logger.log(`[VM ${this.config.vmId}] Acquiring overlay...`);
      this.vmOverlayPath = await acquireOverlay();
      logger.log(`[VM ${this.config.vmId}] Overlay acquired`);

      // Acquire TAP+IP pair from pre-warmed pool
      logger.log(`[VM ${this.config.vmId}] Acquiring TAP+IP...`);
      this.networkConfig = await acquireTap(this.config.vmId);
      logger.log(`[VM ${this.config.vmId}] TAP+IP acquired`);

      // Spawn Firecracker process
      logger.log(`[VM ${this.config.vmId}] Starting Firecracker...`);
      this.process = spawn(
        this.config.firecrackerBinary,
        ["--api-sock", this.socketPath],
        {
          cwd: this.workDir,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        },
      );

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

      // Wait for API to become ready
      this.client = new FirecrackerClient(this.socketPath);
      logger.log(`[VM ${this.config.vmId}] Waiting for API...`);
      await this.client.waitUntilReady(10000, 100);

      // Configure the VM
      this.state = "configuring";
      await this.configure();

      // Boot the VM
      logger.log(`[VM ${this.config.vmId}] Booting...`);
      await this.client.start();
      this.state = "running";

      logger.log(
        `[VM ${this.config.vmId}] Running at ${this.networkConfig.guestIp}`,
      );
    } catch (error) {
      this.state = "error";
      // Cleanup on failure
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Configure the VM via Firecracker API
   *
   * All configuration endpoints are independent and can be called in parallel
   * before InstanceStart. This saves ~10-15ms of Node.js async/await overhead.
   * See: https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests.md
   */
  private async configure(): Promise<void> {
    if (!this.client || !this.networkConfig || !this.vmOverlayPath) {
      throw new Error("VM not properly initialized");
    }

    // Prepare boot args
    // Boot args:
    //   - console=ttyS0: serial console output
    //   - reboot=k: use keyboard controller for reboot
    //   - panic=1: reboot after 1 second on kernel panic
    //   - pci=off: disable PCI bus (not needed in microVM)
    //   - nomodules: skip module loading (not needed in microVM)
    //   - random.trust_cpu=on: trust CPU RNG, skip entropy wait
    //   - quiet loglevel=0: minimize kernel log output
    //   - nokaslr: disable kernel address space randomization
    //   - audit=0: disable kernel auditing
    //   - numa=off: disable NUMA (single node)
    //   - mitigations=off: disable CPU vulnerability mitigations
    //   - noresume: skip hibernation resume check
    //   - init=/sbin/vm-init: use vm-init (Rust binary) for filesystem setup and vsock-agent
    //   - ip=...: network configuration (guest IP, gateway, netmask)
    const networkBootArgs = generateNetworkBootArgs(this.networkConfig);
    const bootArgs = `console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on quiet loglevel=0 nokaslr audit=0 numa=off mitigations=off noresume init=/sbin/vm-init ${networkBootArgs}`;

    // Log configuration
    logger.log(
      `[VM ${this.config.vmId}] Configuring: ${this.config.vcpus} vCPUs, ${this.config.memoryMb}MB RAM, rootfs=${this.config.rootfsPath}, overlay=${this.vmOverlayPath}, network=${this.networkConfig.tapDevice}, vsock=${this.vsockPath}`,
    );
    logger.log(`[VM ${this.config.vmId}] Boot args: ${bootArgs}`);

    // Execute all configuration API calls in parallel
    logger.log(`[VM ${this.config.vmId}] Sending config API calls...`);
    await Promise.all([
      // Machine config (vCPUs, memory)
      this.client.setMachineConfig({
        vcpu_count: this.config.vcpus,
        mem_size_mib: this.config.memoryMb,
      }),
      // Boot source (kernel)
      this.client.setBootSource({
        kernel_image_path: this.config.kernelPath,
        boot_args: bootArgs,
      }),
      // Base drive (squashfs, read-only, shared across VMs)
      // Mounted as /dev/vda inside the VM
      this.client.setDrive({
        drive_id: "rootfs",
        path_on_host: this.config.rootfsPath,
        is_root_device: true,
        is_read_only: true,
      }),
      // Overlay drive (ext4, read-write, per-VM)
      // Mounted as /dev/vdb inside the VM
      // The vm-init script combines these using overlayfs
      this.client.setDrive({
        drive_id: "overlay",
        path_on_host: this.vmOverlayPath,
        is_root_device: false,
        is_read_only: false,
      }),
      // Network interface
      this.client.setNetworkInterface({
        iface_id: "eth0",
        guest_mac: this.networkConfig.guestMac,
        host_dev_name: this.networkConfig.tapDevice,
      }),
      // Vsock for host-guest communication
      // Guest CID 3 is the standard guest identifier (CID 0=hypervisor, 1=local, 2=host)
      this.client.setVsock({
        vsock_id: "vsock0",
        guest_cid: 3,
        uds_path: this.vsockPath,
      }),
    ]);
    logger.log(`[VM ${this.config.vmId}] Config API calls completed`);
  }

  /**
   * Stop the VM gracefully
   */
  async stop(): Promise<void> {
    if (this.state !== "running") {
      logger.log(`[VM ${this.config.vmId}] Not running, state: ${this.state}`);
      return;
    }

    this.state = "stopping";
    logger.log(`[VM ${this.config.vmId}] Stopping...`);

    try {
      // Send graceful shutdown signal
      if (this.client) {
        await this.client.sendCtrlAltDel().catch((error: unknown) => {
          // Expected: API may fail if VM is already stopping
          logger.log(
            `[VM ${this.config.vmId}] Graceful shutdown signal failed (VM may already be stopping): ${error instanceof Error ? error.message : error}`,
          );
        });
      }
    } finally {
      await this.cleanup();
    }
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

    // Release TAP device back to pool
    if (this.networkConfig) {
      try {
        await releaseTap(
          this.networkConfig.tapDevice,
          this.networkConfig.guestIp,
          this.config.vmId,
        );
      } catch (err) {
        logger.log(
          `[VM ${this.config.vmId}] Failed to release TAP: ${err instanceof Error ? err.message : "Unknown"}`,
        );
      }
      this.networkConfig = null;
    }

    // Delete overlay file (from pool, not in workDir)
    if (this.vmOverlayPath && fs.existsSync(this.vmOverlayPath)) {
      fs.unlinkSync(this.vmOverlayPath);
      this.vmOverlayPath = null;
    }

    // Clean up entire workDir (includes socket)
    if (fs.existsSync(this.workDir)) {
      fs.rmSync(this.workDir, { recursive: true, force: true });
    }

    this.client = null;
    this.state = "stopped";
    logger.log(`[VM ${this.config.vmId}] Stopped`);
  }

  /**
   * Wait for the VM process to exit
   * Returns the exit code
   */
  async waitForExit(timeoutMs: number = 60000): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        resolve(0);
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error(`VM did not exit within ${timeoutMs}ms`));
      }, timeoutMs);

      this.process.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code ?? 0);
      });
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
}
