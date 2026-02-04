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
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { acquireNetns, releaseNetns, type PooledNetns } from "./netns-pool.js";
import { SNAPSHOT_NETWORK } from "./netns.js";
import { acquireOverlay } from "./overlay-pool.js";
import { FirecrackerClient } from "./client.js";
import { createLogger } from "../logger.js";
import { vmPaths } from "../paths.js";
import { killProcessTree } from "../utils/process.js";
import type { VmId } from "./vm-id.js";
import { buildFirecrackerConfig, type FirecrackerConfig } from "./config.js";

const logger = createLogger("VM");

/**
 * Snapshot paths for restoring a VM from snapshot
 */
export interface SnapshotPaths {
  /** Path to the snapshot state file */
  snapshot: string;
  /** Path to the memory file */
  memory: string;
  /** Path to the overlay file recorded in snapshot (for bind mount) */
  snapshotOverlay: string;
  /** Path to the vsock directory recorded in snapshot (for bind mount) */
  snapshotVsockDir: string;
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
    this.apiSocketPath = vmPaths.apiSock(this.workDir);
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

    // Use sudo to enter netns, but run Firecracker as current user
    // This ensures created files (sockets) are owned by current user, not root
    const currentUser = os.userInfo().username;
    this.process = spawn(
      "sudo",
      [
        "ip",
        "netns",
        "exec",
        this.netns!.name,
        "sudo",
        "-u",
        currentUser,
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
   * Snapshot contains original absolute paths for drives. We use mount namespace
   * isolation to bind mount our actual overlay file to the path expected by the snapshot.
   * This allows concurrent VMs to each have their own overlay while restoring from
   * the same snapshot.
   */
  private async startFromSnapshot(snapshot: SnapshotPaths): Promise<void> {
    logger.log(
      `[VM ${this.config.vmId}] Starting Firecracker (snapshot restore)...`,
    );
    logger.log(`[VM ${this.config.vmId}] Snapshot: ${snapshot.snapshot}`);
    logger.log(`[VM ${this.config.vmId}] Memory: ${snapshot.memory}`);

    // Snapshot records absolute paths for overlay and vsock
    // We use bind mounts to redirect these to the actual VM paths:
    // - Vsock dir: for vsock UDS (Firecracker connects to {uds_path}_{port})
    // - Overlay: for block device
    const actualVsockDir = vmPaths.vsockDir(this.workDir);
    logger.log(
      `[VM ${this.config.vmId}] Snapshot vsock: ${snapshot.snapshotVsockDir}`,
    );
    logger.log(
      `[VM ${this.config.vmId}] Snapshot overlay: ${snapshot.snapshotOverlay}`,
    );
    logger.log(`[VM ${this.config.vmId}] Actual vsock: ${actualVsockDir}`);
    logger.log(
      `[VM ${this.config.vmId}] Actual overlay: ${this.vmOverlayPath}`,
    );

    // Ensure snapshot directories exist for bind mount targets
    fs.mkdirSync(snapshot.snapshotVsockDir, { recursive: true });
    fs.mkdirSync(path.dirname(snapshot.snapshotOverlay), {
      recursive: true,
    });

    // Create empty file as bind mount target for overlay
    if (!fs.existsSync(snapshot.snapshotOverlay)) {
      fs.writeFileSync(snapshot.snapshotOverlay, "");
    }

    // Use unshare to create isolated mount namespace, then bind mount:
    // 1. Vsock dir: actual vsock dir -> snapshot vsock dir
    // 2. Overlay: actual overlay from pool -> snapshot overlay path
    const currentUser = os.userInfo().username;
    const bindMountVsock = `mount --bind "${actualVsockDir}" "${snapshot.snapshotVsockDir}"`;
    const bindMountOverlay = `mount --bind "${this.vmOverlayPath}" "${snapshot.snapshotOverlay}"`;
    const firecrackerCmd = [
      "ip",
      "netns",
      "exec",
      this.netns!.name,
      "sudo",
      "-u",
      currentUser,
      this.config.firecrackerBinary,
      "--api-sock",
      this.apiSocketPath,
    ].join(" ");

    this.process = spawn(
      "sudo",
      [
        "unshare",
        "--mount",
        "bash",
        "-c",
        `${bindMountVsock} && ${bindMountOverlay} && ${firecrackerCmd}`,
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

    // Load snapshot and resume (drives are configured from snapshot state)
    logger.log(`[VM ${this.config.vmId}] Loading snapshot...`);
    await client.loadSnapshot({
      snapshot_path: snapshot.snapshot,
      mem_backend: {
        backend_path: snapshot.memory,
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
   */
  private buildConfig(): FirecrackerConfig {
    if (!this.netns || !this.vmOverlayPath) {
      throw new Error("VM not properly initialized");
    }

    const config = buildFirecrackerConfig({
      kernelPath: this.config.kernelPath,
      rootfsPath: this.config.rootfsPath,
      overlayPath: this.vmOverlayPath,
      vsockPath: this.vsockPath,
      vcpus: this.config.vcpus,
      memoryMb: this.config.memoryMb,
    });

    logger.log(
      `[VM ${this.config.vmId}] Boot args: ${config["boot-source"].boot_args}`,
    );

    return config;
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
    // Kill Firecracker process tree (sudo -> firecracker)
    // Must kill children first, otherwise they become orphan processes
    if (this.process && !this.process.killed && this.process.pid) {
      killProcessTree(this.process.pid);
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
