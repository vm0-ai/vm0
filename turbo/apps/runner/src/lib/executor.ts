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

import path from "path";
import { FirecrackerVM, type VMConfig } from "./firecracker/vm.js";
import type { GuestClient } from "./firecracker/guest.js";
import { VsockClient } from "./firecracker/vsock.js";
import {
  setupVMProxyRules,
  removeVMProxyRules,
} from "./firecracker/network.js";
import type { ExecutionContext } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { ENV_LOADER_PATH } from "./scripts/index.js";
import { getVMRegistry } from "./proxy/index.js";
import { withSandboxTiming, recordRunnerOperation } from "./metrics/index.js";

// Import from extracted modules
import type {
  ExecutionResult,
  ExecutionOptions,
  PreflightResult,
} from "./executor-types.js";
import { buildEnvironmentVariables, ENV_JSON_PATH } from "./executor-env.js";
import { uploadNetworkLogs } from "./network-logs/index.js";
import {
  downloadStorages,
  restoreSessionHistory,
  installProxyCA,
} from "./vm-setup/index.js";

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
 * Map curl exit codes to meaningful error messages
 * Exported for testing
 */
export const CURL_ERROR_MESSAGES: Record<number, string> = {
  6: "DNS resolution failed",
  7: "Connection refused",
  28: "Connection timeout",
  60: "TLS certificate error (proxy CA not trusted)",
  22: "HTTP error from server",
};

/**
 * Preflight connectivity check - verify VM can reach VM0 API
 * Run this AFTER network is configured but BEFORE starting agent
 *
 * This function uses guest.exec() to run curl inside the VM (not on the host).
 * The curl command is hardcoded with no user input interpolation, so shell
 * injection is not a concern here.
 *
 * @param guest - Guest client connected to the VM
 * @param apiUrl - VM0 API URL to test
 * @param runId - Run ID for the heartbeat request
 * @param sandboxToken - Authentication token for the API
 * @param bypassSecret - Optional Vercel automation bypass secret for preview deployments
 * @returns PreflightResult indicating success or failure with error message
 */
export async function runPreflightCheck(
  guest: GuestClient,
  apiUrl: string,
  runId: string,
  sandboxToken: string,
  bypassSecret?: string,
): Promise<PreflightResult> {
  const heartbeatUrl = `${apiUrl}/api/webhooks/agent/heartbeat`;

  // Build curl command to send test heartbeat from inside VM
  // -s: silent mode (no progress bar)
  // -f: fail silently on HTTP errors (returns exit code 22)
  // --connect-timeout: max time for connection phase
  // --max-time: total max time for the request
  // Note: This runs inside the VM via vsock, not on the runner host
  const bypassHeader = bypassSecret
    ? ` -H "x-vercel-protection-bypass: ${bypassSecret}"`
    : "";
  const curlCmd = `curl -sf --connect-timeout 5 --max-time 10 "${heartbeatUrl}" -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${sandboxToken}"${bypassHeader} -d '{"runId":"${runId}"}'`;

  // Use 20 second timeout for exec (curl has 10s max-time, plus buffer for overhead)
  const result = await guest.exec(curlCmd, 20000);

  if (result.exitCode === 0) {
    return { success: true };
  }

  // Map curl exit code to meaningful error message
  const errorDetail =
    CURL_ERROR_MESSAGES[result.exitCode] ?? `curl exit code ${result.exitCode}`;
  const stderrInfo = result.stderr?.trim() ? ` (${result.stderr.trim()})` : "";

  return {
    success: false,
    error: `Preflight check failed: ${errorDetail}${stderrInfo} - VM cannot reach VM0 API at ${apiUrl}`,
  };
}

/**
 * Report preflight failure to complete API
 * This allows CLI to see the error immediately instead of waiting forever
 *
 * @param apiUrl - VM0 API URL
 * @param runId - Run ID to mark as failed
 * @param sandboxToken - Authentication token
 * @param error - Error message to report
 * @param bypassSecret - Optional Vercel automation bypass secret for preview deployments
 */
export async function reportPreflightFailure(
  apiUrl: string,
  runId: string,
  sandboxToken: string,
  error: string,
  bypassSecret?: string,
): Promise<void> {
  const completeUrl = `${apiUrl}/api/webhooks/agent/complete`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${sandboxToken}`,
  };

  // Add Vercel bypass header for preview deployments
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  try {
    const response = await fetch(completeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        runId,
        exitCode: 1,
        error,
      }),
    });

    if (!response.ok) {
      console.error(
        `[Executor] Failed to report preflight failure: HTTP ${response.status}`,
      );
    }
  } catch (err) {
    console.error(`[Executor] Failed to report preflight failure: ${err}`);
  }
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
  // Use runId (UUID) to derive unique VM identifier
  // This ensures no conflicts even across process restarts
  const vmId = getVmIdFromRunId(context.runId);
  let vm: FirecrackerVM | null = null;
  let guestIp: string | null = null;

  // Use custom logger if provided, otherwise default to console.log
  const log = options.logger ?? ((msg: string) => console.log(msg));

  log(`[Executor] Starting job ${context.runId} in VM ${vmId}`);

  try {
    // Create VM configuration
    // Use workspaces directory under runner's working directory for easy cleanup
    // When runner is stopped, the entire PR directory can be deleted
    const workspacesDir = path.join(process.cwd(), "workspaces");
    const vmConfig: VMConfig = {
      vmId,
      vcpus: config.sandbox.vcpu,
      memoryMb: config.sandbox.memory_mb,
      kernelPath: config.firecracker.kernel,
      rootfsPath: config.firecracker.rootfs,
      firecrackerBinary: config.firecracker.binary,
      workDir: path.join(workspacesDir, `vm0-${vmId}`),
      logger: log,
    };

    // Create and start VM
    log(`[Executor] Creating VM ${vmId}...`);
    vm = new FirecrackerVM(vmConfig);
    await withSandboxTiming("vm_create", () => vm!.start());

    // Get VM IP for network security rules
    guestIp = vm.getGuestIp();
    if (!guestIp) {
      throw new Error("VM started but no IP address available");
    }
    log(`[Executor] VM ${vmId} started, guest IP: ${guestIp}`);

    // Create vsock guest client
    const vsockPath = vm.getVsockPath();
    const guest: GuestClient = new VsockClient(vsockPath);
    log(`[Executor] Using vsock for guest communication: ${vsockPath}`);

    // Wait for guest to connect (zero-latency: guest notifies host when ready)
    log(`[Executor] Waiting for guest connection...`);
    await withSandboxTiming("guest_wait", () =>
      guest.waitForGuestConnection(30000),
    );

    log(`[Executor] Guest client ready`);

    // Handle network security with experimental_firewall
    const firewallConfig = context.experimentalFirewall;

    if (firewallConfig?.enabled) {
      const mitmEnabled = firewallConfig.experimental_mitm ?? false;
      const sealSecretsEnabled =
        firewallConfig.experimental_seal_secrets ?? false;

      log(
        `[Executor] Setting up network security for VM ${guestIp} (mitm=${mitmEnabled}, sealSecrets=${sealSecretsEnabled})`,
      );

      // Set up per-VM iptables rules to redirect this VM's traffic to mitmproxy
      // This must be done before the VM makes any network requests
      await setupVMProxyRules(guestIp, config.proxy.port, config.name);

      // Register VM in the proxy registry with firewall rules
      getVMRegistry().register(guestIp, context.runId, context.sandboxToken, {
        firewallRules: firewallConfig?.rules,
        mitmEnabled,
        sealSecretsEnabled,
      });

      // Install proxy CA certificate only if MITM is enabled
      // For SNI-only mode (filter without MITM), we don't need CA
      if (mitmEnabled) {
        const caCertPath = path.join(
          config.proxy.ca_dir,
          "mitmproxy-ca-cert.pem",
        );
        await installProxyCA(guest, caCertPath);
      }
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

    // Build environment variables and write as JSON file in VM
    // Using JSON avoids shell escaping issues entirely - Python loads it directly
    // API URL comes from runner config, not from claim response
    const envVars = buildEnvironmentVariables(context, config.server.url);
    const envJson = JSON.stringify(envVars);
    log(
      `[Executor] Writing env JSON (${envJson.length} bytes) to ${ENV_JSON_PATH}`,
    );
    await guest.writeFile(ENV_JSON_PATH, envJson);

    // Run preflight connectivity check before starting agent
    // This verifies VM can reach VM0 API - if not, we report failure immediately
    // Skip in benchmark mode since it doesn't use API
    if (!options.benchmarkMode) {
      log(`[Executor] Running preflight connectivity check...`);
      const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      const preflight = await runPreflightCheck(
        guest,
        config.server.url,
        context.runId,
        context.sandboxToken,
        bypassSecret,
      );

      if (!preflight.success) {
        log(`[Executor] Preflight check failed: ${preflight.error}`);

        // Report failure via complete API so CLI sees it immediately
        await reportPreflightFailure(
          config.server.url,
          context.runId,
          context.sandboxToken,
          preflight.error!,
          bypassSecret,
        );

        return {
          exitCode: 1,
          error: preflight.error,
        };
      }
      log(`[Executor] Preflight check passed`);
    }

    // Execute agent or direct command based on mode
    const systemLogFile = `/tmp/vm0-main-${context.runId}.log`;
    const exitCodeFile = `/tmp/vm0-exit-${context.runId}`;
    const startTime = Date.now();

    if (options.benchmarkMode) {
      // Benchmark mode: run prompt directly as bash command (skip run-agent.mjs)
      // This avoids API dependencies while still testing the full VM setup pipeline
      log(`[Executor] Running command directly (benchmark mode)...`);
      await guest.exec(
        `nohup sh -c '${context.prompt}; echo $? > ${exitCodeFile}' > ${systemLogFile} 2>&1 &`,
      );
      log(`[Executor] Command started in background`);
    } else {
      // Production mode: run env-loader.mjs which loads environment and runs run-agent.mjs
      log(`[Executor] Running agent via env-loader (background)...`);
      await guest.exec(
        `nohup sh -c 'node ${ENV_LOADER_PATH}; echo $? > ${exitCodeFile}' > ${systemLogFile} 2>&1 &`,
      );
      log(`[Executor] Agent started in background`);
    }

    // Poll for completion by checking if exit code file exists
    // Timeout after 2 hours (same as E2B sandbox timeout)
    const pollIntervalMs = 2000; // Check every 2 seconds
    const maxWaitMs = 2 * 60 * 60 * 1000; // 2 hours max
    let exitCode = 1;
    let completed = false;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      // Check if exit code file exists
      const checkResult = await guest.exec(`cat ${exitCodeFile} 2>/dev/null`);
      if (checkResult.exitCode === 0 && checkResult.stdout.trim()) {
        const parsed = parseInt(checkResult.stdout.trim(), 10);
        exitCode = Number.isNaN(parsed) ? 1 : parsed;
        completed = true;
        break;
      }

      // Check if agent process is still running (production mode only)
      // If exit code file doesn't exist but process is dead, agent crashed unexpectedly
      if (!options.benchmarkMode) {
        const processCheck = await guest.exec(
          `pgrep -f "env-loader.mjs" > /dev/null 2>&1 && echo "RUNNING" || echo "DEAD"`,
        );

        if (processCheck.stdout.trim() === "DEAD") {
          // Process is dead but no exit code file - agent crashed unexpectedly
          log(
            `[Executor] Agent process died unexpectedly without writing exit code`,
          );

          // Try to get diagnostic info from system log and dmesg
          const logContent = await guest.exec(
            `tail -50 ${systemLogFile} 2>/dev/null`,
          );
          const dmesgCheck = await guest.exec(
            `dmesg | tail -20 | grep -iE "killed|oom" 2>/dev/null`,
          );

          let errorMsg = "Agent process terminated unexpectedly";
          if (
            dmesgCheck.stdout.toLowerCase().includes("oom") ||
            dmesgCheck.stdout.toLowerCase().includes("killed")
          ) {
            errorMsg = "Agent process killed by OOM killer";
            log(`[Executor] OOM detected: ${dmesgCheck.stdout}`);
          }
          if (logContent.stdout) {
            log(
              `[Executor] Last log output: ${logContent.stdout.substring(0, 500)}`,
            );
          }

          // Record metric and return failure
          const durationMs = Date.now() - startTime;
          recordRunnerOperation({
            actionType: "agent_execute",
            durationMs,
            success: false,
          });

          return {
            exitCode: 1,
            error: errorMsg,
          };
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const duration = Math.round(durationMs / 1000);

    if (!completed) {
      log(`[Executor] Agent timed out after ${duration}s`);
      // Record agent_execute metric for timeout
      recordRunnerOperation({
        actionType: "agent_execute",
        durationMs,
        success: false,
      });
      return {
        exitCode: 1,
        error: `Agent execution timed out after ${duration}s`,
      };
    }

    // Record agent_execute metric
    recordRunnerOperation({
      actionType: "agent_execute",
      durationMs,
      success: exitCode === 0,
    });

    log(`[Executor] Agent finished in ${duration}s with exit code ${exitCode}`);

    // Read log file for debugging output
    const logResult = await guest.exec(
      `tail -100 ${systemLogFile} 2>/dev/null`,
    );
    if (logResult.stdout) {
      log(
        `[Executor] Log output (${logResult.stdout.length} chars): ${logResult.stdout.substring(0, 500)}`,
      );
    }

    return {
      exitCode,
      error: exitCode !== 0 ? logResult.stdout || undefined : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Executor] Job ${context.runId} failed: ${errorMsg}`);

    return {
      exitCode: 1,
      error: errorMsg,
    };
  } finally {
    // Clean up network security if firewall was enabled
    if (context.experimentalFirewall?.enabled && guestIp) {
      log(`[Executor] Cleaning up network security for VM ${guestIp}`);

      // Remove per-VM iptables rules first
      try {
        await removeVMProxyRules(guestIp, config.proxy.port, config.name);
      } catch (err) {
        console.error(
          `[Executor] Failed to remove VM proxy rules: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }

      // Unregister from proxy registry
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
          console.error(
            `[Executor] Failed to upload network logs: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
        }
      }
    }

    // Always cleanup VM - let errors propagate (fail-fast principle)
    if (vm) {
      log(`[Executor] Cleaning up VM ${vmId}...`);
      await withSandboxTiming("cleanup", () => vm!.kill());
    }
  }
}
