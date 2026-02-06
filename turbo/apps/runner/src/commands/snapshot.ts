/**
 * Snapshot Command
 *
 * Generates a Firecracker snapshot for fast VM startup.
 * This is a one-time operation typically run during deployment/CI.
 *
 * Process:
 * 1. Create network namespace with TAP device
 * 2. Create overlay filesystem
 * 3. Start Firecracker with --api-sock only
 * 4. Configure VM via API (machine, boot-source, drives, network, vsock)
 * 5. Start VM via API (InstanceStart)
 * 6. Wait for guest to become ready (vsock)
 * 7. Pause VM via API
 * 8. Create snapshot (state + memory)
 * 9. Copy overlay as golden overlay
 * 10. Cleanup
 *
 * Outputs (in output directory):
 * - snapshot.bin: VM state snapshot
 * - memory.bin: VM memory snapshot
 * - overlay.ext4: Golden overlay with guest state
 */

import { Command } from "commander";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { loadDebugConfig, validateFirecrackerPaths } from "../lib/config.js";
import { Timer } from "../lib/utils/timing.js";
import { setGlobalLogger, createLogger } from "../lib/logger.js";
import { VsockClient } from "../lib/firecracker/vsock.js";
import { FirecrackerClient } from "../lib/firecracker/client.js";
import {
  SNAPSHOT_NETWORK,
  createNetnsWithTap,
  deleteNetns,
} from "../lib/firecracker/netns.js";
import { createOverlayFile } from "../lib/firecracker/overlay-pool.js";
import { execCommand } from "../lib/utils/exec.js";
import { buildBootArgs } from "../lib/firecracker/config.js";
import { vmPaths, runnerPaths, snapshotOutputPaths } from "../lib/paths.js";

interface SnapshotOptions {
  config: string;
  output: string;
}

const logger = createLogger("Snapshot");

/**
 * Start Firecracker process with API socket only (no config file)
 *
 * This allows us to configure the VM via API before starting it,
 * avoiding race conditions with config-file mode.
 */
function startFirecracker(
  nsName: string,
  firecrackerBinary: string,
  apiSocketPath: string,
  workDir: string,
): ChildProcess {
  logger.log("Starting Firecracker with API socket...");

  // Use sudo to enter netns, but run Firecracker as current user
  // This ensures created files (sockets) are owned by current user, not root
  const currentUser = os.userInfo().username;
  const fcProcess = spawn(
    "sudo",
    [
      "ip",
      "netns",
      "exec",
      nsName,
      "sudo",
      "-u",
      currentUser,
      firecrackerBinary,
      "--api-sock",
      apiSocketPath,
    ],
    {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  // Log stdout/stderr
  if (fcProcess.stdout) {
    const stdoutRL = readline.createInterface({ input: fcProcess.stdout });
    stdoutRL.on("line", (line) => {
      if (line.trim()) logger.log(`[FC] ${line}`);
    });
  }
  if (fcProcess.stderr) {
    const stderrRL = readline.createInterface({ input: fcProcess.stderr });
    stderrRL.on("line", (line) => {
      if (line.trim()) logger.log(`[FC stderr] ${line}`);
    });
  }

  fcProcess.on("error", (err) => logger.log(`Firecracker error: ${err}`));
  fcProcess.on("exit", (code, signal) =>
    logger.log(`Firecracker exited: code=${code}, signal=${signal}`),
  );

  return fcProcess;
}

export const snapshotCommand = new Command("snapshot")
  .description("Generate a Firecracker snapshot for fast VM startup")
  .argument("<output-dir>", "Output directory for snapshot files")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .action(
    async (outputDir: string, opts: Record<string, string>): Promise<void> => {
      const options: SnapshotOptions = {
        config: opts.config ?? "./runner.yaml",
        output: outputDir,
      };

      const timer = new Timer();
      setGlobalLogger(timer.log.bind(timer));

      // Load and validate config first (needed for base_dir)
      logger.log("Loading configuration...");
      const config = loadDebugConfig(options.config);
      validateFirecrackerPaths(config.firecracker);

      const nsName = "vm0-snapshot";
      const workDir = runnerPaths.snapshotWorkDir(config.base_dir);
      const overlayPath = vmPaths.overlay(workDir);
      const vsockPath = vmPaths.vsock(workDir);
      const apiSocketPath = vmPaths.apiSock(workDir);

      // Output files
      const outputSnapshot = snapshotOutputPaths.snapshot(options.output);
      const outputMemory = snapshotOutputPaths.memory(options.output);
      const outputOverlay = snapshotOutputPaths.overlay(options.output);

      let fcProcess: ChildProcess | null = null;
      let vsockClient: VsockClient | null = null;
      let exitCode = 0;

      try {
        // Clean up any stale work directory from previous run
        if (fs.existsSync(workDir)) {
          logger.log("Cleaning up stale work directory...");
          fs.rmSync(workDir, { recursive: true, force: true });
        }

        // Create directories
        logger.log(`Creating directories...`);
        fs.mkdirSync(options.output, { recursive: true });
        fs.mkdirSync(workDir, { recursive: true });
        fs.mkdirSync(vmPaths.vsockDir(workDir), { recursive: true });

        // Create overlay
        logger.log("Creating overlay filesystem...");
        await createOverlayFile(overlayPath);
        logger.log(`Overlay created: ${overlayPath}`);

        // Create network namespace
        logger.log(`Creating network namespace: ${nsName}`);
        await deleteNetns(nsName); // Clean up any stale namespace
        await createNetnsWithTap(nsName, {
          tapName: SNAPSHOT_NETWORK.tapName,
          gatewayIpWithPrefix: `${SNAPSHOT_NETWORK.gatewayIp}/${SNAPSHOT_NETWORK.prefixLen}`,
        });
        logger.log("Network namespace created");

        // Start Firecracker with API socket only (no config file)
        fcProcess = startFirecracker(
          nsName,
          config.firecracker.binary,
          apiSocketPath,
          workDir,
        );

        const apiClient = new FirecrackerClient(apiSocketPath);

        // Wait for API to be ready
        logger.log("Waiting for API to be ready...");
        await apiClient.waitForReady();
        logger.log("API ready");

        // Configure VM via API (parallel - each request uses fresh connection)
        logger.log("Configuring VM via API...");
        await Promise.all([
          apiClient.configureMachine({
            vcpu_count: config.sandbox.vcpu,
            mem_size_mib: config.sandbox.memory_mb,
          }),
          apiClient.configureBootSource({
            kernel_image_path: config.firecracker.kernel,
            boot_args: buildBootArgs(),
          }),
          apiClient.configureDrive({
            drive_id: "rootfs",
            path_on_host: config.firecracker.rootfs,
            is_root_device: true,
            is_read_only: true,
          }),
          apiClient.configureDrive({
            drive_id: "overlay",
            path_on_host: overlayPath,
            is_root_device: false,
            is_read_only: false,
          }),
          apiClient.configureNetworkInterface({
            iface_id: "eth0",
            guest_mac: SNAPSHOT_NETWORK.guestMac,
            host_dev_name: SNAPSHOT_NETWORK.tapName,
          }),
          apiClient.configureVsock({
            guest_cid: 3,
            uds_path: vsockPath,
          }),
        ]);
        logger.log("VM configured");

        // Start vsock listener BEFORE starting VM to avoid race condition
        // Guest's vsock-guest connects immediately after boot (~300ms)
        logger.log("Starting vsock listener...");
        vsockClient = new VsockClient(vsockPath);
        const guestConnectionPromise =
          vsockClient.waitForGuestConnection(60000);

        // Start the VM via API
        logger.log("Starting VM...");
        await apiClient.startInstance();
        logger.log("VM started");

        // Wait for guest to connect via vsock
        logger.log("Waiting for guest connection...");
        await guestConnectionPromise;
        logger.log("Guest connected");

        // Verify guest is responsive
        logger.log("Verifying guest is responsive...");
        const reachable = await vsockClient.isReachable();
        if (!reachable) {
          throw new Error("Guest is not responsive");
        }
        logger.log("Guest is responsive");

        // Pause the VM
        logger.log("Pausing VM...");
        await apiClient.pause();
        logger.log("VM paused");

        // Create snapshot
        logger.log("Creating snapshot...");
        await apiClient.createSnapshot({
          snapshot_type: "Full",
          snapshot_path: outputSnapshot,
          mem_file_path: outputMemory,
        });
        logger.log("Snapshot created");

        // Copy overlay as golden overlay (sparse copy for speed)
        logger.log("Copying overlay as golden overlay...");
        await execCommand(
          `cp --sparse=always "${overlayPath}" "${outputOverlay}"`,
          false,
        );
        logger.log("Golden overlay created");

        // Success
        logger.log("=".repeat(40));
        logger.log("Snapshot generation complete!");
        logger.log("Files (logical size):");
        const lsOutput = await execCommand(`ls -lh "${options.output}"`, false);
        logger.log(lsOutput);
        logger.log("Actual disk usage:");
        const duOutput = await execCommand(
          `du -h "${options.output}"/*`,
          false,
        );
        logger.log(duOutput);
        logger.log("=".repeat(40));
      } catch (error) {
        logger.error(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        exitCode = 1;
      } finally {
        // Cleanup
        logger.log("Cleaning up...");

        // Close vsock
        if (vsockClient) {
          vsockClient.close();
        }

        // Kill Firecracker
        // Note: fcProcess is the sudo process, not firecracker itself.
        // Kill sudo first, then use pkill to ensure firecracker is terminated.
        if (fcProcess && !fcProcess.killed) {
          fcProcess.kill("SIGKILL");
        }
        // Ensure firecracker is killed (sudo may not propagate SIGKILL to children)
        await execCommand(
          `pkill -9 -f "firecracker.*${apiSocketPath}"`,
          true,
        ).catch(() => {});

        // Delete network namespace
        await deleteNetns(nsName);

        // Clean up work directory
        if (fs.existsSync(workDir)) {
          fs.rmSync(workDir, { recursive: true, force: true });
        }

        logger.log("Cleanup complete");
      }

      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    },
  );
