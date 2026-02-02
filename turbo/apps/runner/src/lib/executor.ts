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

import { FirecrackerVM, type VMConfig } from "./firecracker/vm.js";
import type { GuestClient } from "./firecracker/guest.js";
import { VsockClient } from "./firecracker/vsock.js";
import type { ExecutionContext } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { runnerPaths } from "./paths.js";
import { ENV_LOADER_PATH } from "./scripts/index.js";
import { getVMRegistry } from "./proxy/index.js";
import {
  withSandboxTiming,
  recordOperation,
  setSandboxContext,
  clearSandboxContext,
} from "./metrics/index.js";

// Import from extracted modules
import type { ExecutionResult, ExecutionOptions } from "./executor-types.js";
import { buildEnvironmentVariables, ENV_JSON_PATH } from "./executor-env.js";
import { uploadNetworkLogs } from "./network-logs/index.js";
import { downloadStorages, restoreSessionHistory } from "./vm-setup/index.js";
import { createLogger } from "./logger.js";

const logger = createLogger("Executor");

/**
 * Extract short VM ID from runId (UUID)
 * Uses first 8 characters of UUID for unique identification
 */
function getVmIdFromRunId(runId: string): string {
  // runId is a UUID like "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  // Extract first 8 chars (before first hyphen) for a unique short ID
  return runId.split("-")[0] || runId.substring(0, 8);
}

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
  const vmId = getVmIdFromRunId(context.runId);
  let vm: FirecrackerVM | null = null;
  let guestIp: string | null = null;
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

    // Create and start VM
    logger.log(`Creating VM ${vmId}...`);
    vm = new FirecrackerVM(vmConfig);
    await withSandboxTiming("vm_create", () => vm!.start());

    // Get VM IP for network security rules
    guestIp = vm.getGuestIp();
    if (!guestIp) {
      throw new Error("VM started but no IP address available");
    }
    logger.log(`VM ${vmId} started, guest IP: ${guestIp}`);

    // Create vsock guest client
    const vsockPath = vm.getVsockPath();
    vsockClient = new VsockClient(vsockPath);
    const guest: GuestClient = vsockClient;
    logger.log(`Using vsock for guest communication: ${vsockPath}`);

    // Pre-build env JSON before waiting for guest (sync, no guest dependency)
    const envJson = JSON.stringify(
      buildEnvironmentVariables(context, config.server.url),
    );

    // Handle network security before guest wait (sync, no guest dependency)
    const firewallConfig = context.experimentalFirewall;
    if (firewallConfig?.enabled) {
      const mitmEnabled = firewallConfig.experimental_mitm ?? false;
      const sealSecretsEnabled =
        firewallConfig.experimental_seal_secrets ?? false;

      logger.log(
        `Setting up network security for VM ${guestIp} (mitm=${mitmEnabled}, sealSecrets=${sealSecretsEnabled})`,
      );

      // Register VM in the proxy registry with firewall rules
      // Note: CIDR-based iptables rules are set up at runner startup (setup.ts)
      // so we don't need per-VM iptables rules here
      getVMRegistry().register(guestIp!, context.runId, context.sandboxToken, {
        firewallRules: firewallConfig?.rules,
        mitmEnabled,
        sealSecretsEnabled,
      });
      // Note: Proxy CA certificate is pre-baked into rootfs (see build-rootfs.sh)
      // No runtime installation needed
    }

    // Wait for guest to connect (blocks during kernel boot ~335ms)
    logger.log(`Waiting for guest connection...`);
    await withSandboxTiming("guest_wait", () =>
      guest.waitForGuestConnection(30000),
    );
    logger.log(`Guest client ready`);

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

    // Write pre-built env JSON to VM
    // Using JSON avoids shell escaping issues entirely - Python loads it directly
    logger.log(
      `Writing env JSON (${envJson.length} bytes) to ${ENV_JSON_PATH}`,
    );
    await guest.writeFile(ENV_JSON_PATH, envJson);

    // Execute agent or direct command using event-driven mode
    // Note: Network connectivity is validated by agent's first heartbeat (fail-fast)
    // The agent spawns in background, and we wait for exit notification (no polling)
    const systemLogFile = `/tmp/vm0-main-${context.runId}.log`;
    const startTime = Date.now();
    const maxWaitMs = 2 * 60 * 60 * 1000; // 2 hours max (same as E2B sandbox timeout)

    // Build the command to run
    let command: string;
    if (options.benchmarkMode) {
      // Benchmark mode: run prompt directly as bash command (skip run-agent.mjs)
      logger.log(`Running command directly (benchmark mode)...`);
      command = `${context.prompt} > ${systemLogFile} 2>&1`;
    } else {
      // Production mode: run env-loader.mjs which loads environment and runs run-agent.mjs
      logger.log(`Running agent via env-loader...`);
      command = `node ${ENV_LOADER_PATH} > ${systemLogFile} 2>&1`;
    }

    // Spawn process and get PID (returns immediately)
    const { pid } = await guest.spawnAndWatch(command, maxWaitMs);
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
        `dmesg | tail -20 | grep -iE "killed|oom" 2>/dev/null`,
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
    if (context.experimentalFirewall?.enabled && guestIp) {
      logger.log(`Cleaning up network security for VM ${guestIp}`);

      // Unregister from proxy registry
      // Note: CIDR-based iptables rules are global (set at runner startup)
      // so we don't need to remove per-VM rules here
      getVMRegistry().unregister(guestIp);

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
