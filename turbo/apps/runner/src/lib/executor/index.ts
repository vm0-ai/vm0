/**
 * Job Executor
 *
 * Executes agent jobs inside Firecracker VMs.
 * Handles VM lifecycle, script injection via vsock, and job completion.
 *
 * This executor achieves E2B parity by:
 * - Uploading the same Python scripts used by E2B
 * - Setting the same environment variables
 * - Supporting storage download and artifact upload
 * - Supporting checkpoint/resume functionality
 */

import fs from "node:fs";
import path from "node:path";
import { FirecrackerVM, type VMConfig } from "../firecracker/vm.js";
import { createVmId } from "../firecracker/vm-id.js";
import type { GuestClient } from "../firecracker/guest.js";
import { VsockClient } from "../firecracker/vsock.js";
import type { ExecutionContext } from "../api.js";
import type { RunnerConfig } from "../config.js";
import { runnerPaths, vmPaths } from "../paths.js";
import { GUEST_BINARY_PATHS } from "../scripts/index.js";
import { getVMRegistry } from "../proxy/index.js";
import {
  withSandboxTiming,
  recordOperation,
  setSandboxContext,
  clearSandboxContext,
} from "../metrics/index.js";

// Import from extracted modules
import type { ExecutionResult, ExecutionOptions } from "./types.js";
import { buildEnvironmentVariables } from "./env.js";
import { uploadNetworkLogs } from "../network-logs/index.js";
import { downloadStorages, restoreSessionHistory } from "../vm-setup/index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("Executor");

/**
 * Execute a job in a Firecracker VM
 */
// eslint-disable-next-line complexity -- TODO: refactor complex function
export async function executeJob(
  context: ExecutionContext,
  config: RunnerConfig,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  // Set sandbox context for metrics reporting via telemetry API
  setSandboxContext({
    apiUrl: config.server.url,
    runId: context.runId,
    sandboxToken: context.sandboxToken,
  });

  // Record api_to_vm_start metric
  if (context.apiStartTime) {
    recordOperation({
      actionType: "api_to_vm_start",
      durationMs: Date.now() - context.apiStartTime,
      success: true,
    });
  }

  // Use runId (UUID) to derive unique VM identifier
  // This ensures no conflicts even across process restarts
  const vmId = createVmId(context.runId);
  let vm: FirecrackerVM | null = null;
  let guestIp: string | null = null;
  let vethNsIp: string | null = null; // veth namespace IP for VMRegistry key
  let vsockClient: VsockClient | null = null;

  logger.log(`Starting job ${context.runId} in VM ${vmId}`);

  try {
    // Create VM configuration
    // Use workspaces directory under runner's base_dir for easy cleanup
    // When runner is stopped, the entire base directory can be deleted
    const vmConfig: VMConfig = {
      vmId,
      vcpus: config.sandbox.vcpu,
      memoryMb: config.sandbox.memory_mb,
      kernelPath: config.firecracker.kernel,
      rootfsPath: config.firecracker.rootfs,
      firecrackerBinary: config.firecracker.binary,
      workDir: runnerPaths.vmWorkDir(config.base_dir, vmId),
    };
    // Remove old workDir and create fresh one before VM starts
    fs.rmSync(vmConfig.workDir, { recursive: true, force: true });
    fs.mkdirSync(vmConfig.workDir, { recursive: true });
    fs.mkdirSync(vmPaths.vsockDir(vmConfig.workDir), { recursive: true });

    // Start vsock listener BEFORE VM starts to avoid race condition
    // Guest's vsock-guest connects immediately after boot/resume
    const vsockPath = vmPaths.vsock(vmConfig.workDir);
    vsockClient = new VsockClient(vsockPath);
    const guest: GuestClient = vsockClient;
    logger.log(`Starting vsock listener: ${vsockPath}`);
    const guestConnectionPromise = guest.waitForGuestConnection(30000);

    // Create VM and start
    // - With snapshot config: restore from snapshot (fast boot ~50ms)
    // - Without snapshot: fresh boot (~362ms)
    logger.log(`Creating VM ${vmId}...`);
    vm = new FirecrackerVM(vmConfig);

    // Start VM (Firecracker process begins, guest will connect to vsock)
    // Derive snapshot workdir from snapshot config path:
    // - Snapshot is at {original_base_dir}/snapshot/snapshot.bin
    // - Snapshot was generated with workdir at {original_base_dir}/snapshot-gen/workspaces/snapshot
    // - Paths recorded in snapshot use that workdir
    const snapshotConfig = config.firecracker.snapshot;
    let snapshotPaths: Parameters<typeof vm.start>[0];
    if (snapshotConfig) {
      // Extract original base_dir from snapshot path (go up 2 levels: /snapshot/snapshot.bin)
      const snapshotDir = path.dirname(snapshotConfig.snapshot);
      const originalBaseDir = path.dirname(snapshotDir);
      const snapshotBaseDir = runnerPaths.snapshotBaseDir(originalBaseDir);
      const snapshotWorkDir = runnerPaths.snapshotWorkDir(snapshotBaseDir);
      snapshotPaths = {
        snapshot: snapshotConfig.snapshot,
        memory: snapshotConfig.memory,
        snapshotOverlay: vmPaths.overlay(snapshotWorkDir),
        snapshotVsockDir: vmPaths.vsockDir(snapshotWorkDir),
      };
    }
    await withSandboxTiming("vm_create", () => vm!.start(snapshotPaths));

    // Get VM IPs for logging and network security
    guestIp = vm.getGuestIp();
    vethNsIp = vm.getNetns()?.vethNsIp ?? null;
    if (!guestIp || !vethNsIp) {
      throw new Error("VM started but network not properly configured");
    }
    logger.log(
      `VM ${vmId} started, guest IP: ${guestIp}, veth NS IP: ${vethNsIp}`,
    );

    // Pre-build env vars before waiting for guest (sync, no guest dependency)
    const envVars = buildEnvironmentVariables(context, config.server.url);

    // Handle network security before guest wait (sync, no guest dependency)
    const firewallConfig = context.experimentalFirewall;
    if (firewallConfig?.enabled) {
      const mitmEnabled = firewallConfig.experimental_mitm ?? false;
      const sealSecretsEnabled =
        firewallConfig.experimental_seal_secrets ?? false;

      logger.log(
        `Setting up network security for VM ${vethNsIp} (mitm=${mitmEnabled}, sealSecrets=${sealSecretsEnabled})`,
      );

      // Register VM in the proxy registry with firewall rules
      // vethNsIp is the key since that's what the proxy sees after NAT
      // Note: Per-namespace iptables rules redirect traffic to proxy
      getVMRegistry().register(vethNsIp!, context.runId, context.sandboxToken, {
        firewallRules: firewallConfig?.rules,
        mitmEnabled,
        sealSecretsEnabled,
      });
      // Note: Proxy CA certificate is pre-baked into rootfs (see build-rootfs.sh)
      // No runtime installation needed
    }

    // Wait for guest to connect (vsock listener was started before VM)
    logger.log(`Waiting for guest connection...`);
    await withSandboxTiming("guest_wait", () => guestConnectionPromise);
    logger.log(`Guest client ready`);

    // Post-resume handling for snapshot restore
    // After snapshot restore, guest time continues from snapshot creation time
    // Entropy pool is handled by random.trust_cpu=on boot arg (CPU HWRNG auto-refills)
    // ARP cache: not needed since each VM runs in fresh namespace with new TAP device
    // See: https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
    if (config.firecracker.snapshot) {
      // Use host timestamp directly (faster than hwclock which accesses RTC device)
      const timestamp = (Date.now() / 1000).toFixed(3);
      await guest.exec(`sudo date -s "@${timestamp}"`);
    }

    // Download storages if manifest provided
    if (context.storageManifest) {
      await withSandboxTiming("storage_download", () =>
        downloadStorages(guest, context.storageManifest!),
      );
    }

    // Restore session history if resuming
    if (context.resumeSession) {
      await withSandboxTiming("session_restore", () =>
        restoreSessionHistory(
          guest,
          context.resumeSession!,
          context.workingDir,
          context.cliAgentType || "claude-code",
        ),
      );
    }

    // Execute agent or direct command using event-driven mode
    // Note: Network connectivity is validated by agent's first heartbeat (fail-fast)
    // The agent spawns in background, and we wait for exit notification (no polling)
    const systemLogFile = `/tmp/vm0-main-${context.runId}.log`;
    const startTime = Date.now();
    const maxWaitMs = 2 * 60 * 60 * 1000; // 2 hours max (same as E2B sandbox timeout)

    // Build the command to run
    let command: string;
    if (options.benchmarkMode) {
      // Benchmark mode: run prompt directly as bash command (skip guest-agent)
      logger.log(`Running command directly (benchmark mode)...`);
      command = `${context.prompt} > ${systemLogFile} 2>&1`;
    } else {
      // Production mode: run guest-agent directly with env vars passed via vsock protocol
      logger.log(
        `Running agent via vsock with ${Object.keys(envVars).length} env vars...`,
      );
      command = `${GUEST_BINARY_PATHS.guestAgent} > ${systemLogFile} 2>&1`;
    }

    // Spawn process and get PID (returns immediately)
    // Env vars are passed via vsock protocol — guest agent exports them before running command
    const { pid } = await guest.spawnAndWatch(command, maxWaitMs, envVars);
    logger.log(`Process started with pid=${pid}`);

    // Wait for process exit event (event-driven, no polling)
    // Add 5s buffer to maxWaitMs for exit event timeout
    let exitCode = 1;
    let exitEvent;
    try {
      exitEvent = await guest.waitForExit(pid, maxWaitMs + 5000);
      exitCode = exitEvent.exitCode;
    } catch {
      // Timeout waiting for exit event
      const durationMs = Date.now() - startTime;
      const duration = Math.round(durationMs / 1000);
      logger.log(`Agent timed out after ${duration}s`);
      recordOperation({
        actionType: "agent_execute",
        durationMs,
        success: false,
      });
      return {
        exitCode: 1,
        error: `Agent execution timed out after ${duration}s`,
      };
    }

    const durationMs = Date.now() - startTime;
    const duration = Math.round(durationMs / 1000);

    // Check for OOM kill (exit code 137 = 128 + SIGKILL)
    if (exitCode === 137 || exitCode === 9) {
      const dmesgCheck = await guest.exec(
        `sudo dmesg | tail -20 | grep -iE "killed|oom" 2>/dev/null`,
      );
      if (
        dmesgCheck.stdout.toLowerCase().includes("oom") ||
        dmesgCheck.stdout.toLowerCase().includes("killed")
      ) {
        logger.log(`OOM detected: ${dmesgCheck.stdout}`);
        recordOperation({
          actionType: "agent_execute",
          durationMs,
          success: false,
        });
        return {
          exitCode: 1,
          error: "Agent process killed by OOM killer",
        };
      }
    }

    // Record agent_execute metric
    recordOperation({
      actionType: "agent_execute",
      durationMs,
      success: exitCode === 0,
    });

    logger.log(`Agent finished in ${duration}s with exit code ${exitCode}`);

    // Log output from the process exit event
    if (exitEvent.stderr) {
      logger.log(
        `Stderr (${exitEvent.stderr.length} chars): ${exitEvent.stderr.substring(0, 500)}`,
      );
    }

    return {
      exitCode,
      error: exitCode !== 0 ? exitEvent.stderr || undefined : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`Job ${context.runId} failed: ${errorMsg}`);

    return {
      exitCode: 1,
      error: errorMsg,
    };
  } finally {
    // Clean up network security if firewall was enabled
    if (context.experimentalFirewall?.enabled && vethNsIp) {
      logger.log(`Cleaning up network security for VM ${vethNsIp}`);

      // Unregister from proxy registry (keyed by veth namespace IP)
      getVMRegistry().unregister(vethNsIp);

      // Upload network logs to telemetry endpoint (skip in devMode)
      if (!options.benchmarkMode) {
        try {
          await uploadNetworkLogs(
            config.server.url,
            context.sandboxToken,
            context.runId,
          );
        } catch (err) {
          logger.error(
            `Failed to upload network logs: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
        }
      }
    }

    // Always cleanup VM - let errors propagate (fail-fast principle)
    if (vm) {
      // Request graceful shutdown via vsock (best-effort, timeout after 2s)
      if (vsockClient) {
        const acked = await vsockClient.shutdown(2000);
        if (acked) {
          logger.log(`Guest acknowledged shutdown`);
        } else {
          logger.log(`Guest shutdown timeout, proceeding with SIGKILL`);
        }
        vsockClient.close();
      }
      logger.log(`Cleaning up VM ${vmId}...`);
      await withSandboxTiming("cleanup", () => vm!.kill());
    }

    // Flush and clear sandbox context after job completion
    await clearSandboxContext();
  }
}
