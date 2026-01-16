/**
 * Job Executor
 *
 * Executes agent jobs inside Firecracker VMs.
 * Handles VM lifecycle, script injection via SSH, and job completion.
 *
 * This executor achieves E2B parity by:
 * - Uploading the same Python scripts used by E2B
 * - Setting the same environment variables
 * - Supporting storage download and artifact upload
 * - Supporting checkpoint/resume functionality
 */

import path from "path";
import fs from "fs";
import { FirecrackerVM, type VMConfig } from "./firecracker/vm.js";
import {
  type SSHClient,
  createVMSSHClient,
  getRunnerSSHKeyPath,
} from "./firecracker/guest.js";
import {
  setupVMProxyRules,
  removeVMProxyRules,
} from "./firecracker/network.js";
import type {
  ExecutionContext,
  StorageManifest,
  ResumeSession,
} from "./api.js";
import type { RunnerConfig } from "./config.js";
import { getAllScripts } from "./scripts/utils.js";
import { SCRIPT_PATHS, ENV_LOADER_PATH } from "./scripts/index.js";
import { getVMRegistry } from "./proxy/index.js";
import { withSandboxTiming, recordRunnerOperation } from "./metrics/index.js";

/**
 * Execution result
 */
interface ExecutionResult {
  exitCode: number;
  error?: string;
}

/**
 * Execution options for customizing job execution behavior
 */
interface ExecutionOptions {
  /**
   * Benchmark mode for local VM performance testing without API server:
   * - Runs prompt directly as bash command (skips run-agent.py)
   * - Skips network log upload
   * - Skips telemetry reporting
   * Used by the benchmark command
   */
  benchmarkMode?: boolean;

  /**
   * Custom logger function for execution output.
   * If provided, executor will use this instead of console.log.
   * Useful for adding timestamps or custom prefixes.
   */
  logger?: (message: string) => void;
}

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
 * Build environment variables for the agent execution
 */
function buildEnvironmentVariables(
  context: ExecutionContext,
  apiUrl: string,
): Record<string, string> {
  const envVars: Record<string, string> = {
    VM0_API_URL: apiUrl,
    VM0_RUN_ID: context.runId,
    VM0_API_TOKEN: context.sandboxToken,
    VM0_PROMPT: context.prompt,
    VM0_WORKING_DIR: context.workingDir,
    CLI_AGENT_TYPE: context.cliAgentType || "claude-code",
  };

  // Add Vercel bypass if available
  const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (vercelBypass) {
    envVars.VERCEL_PROTECTION_BYPASS = vercelBypass;
  }

  // Pass USE_MOCK_CLAUDE from host environment for testing
  const useMockClaude = process.env.USE_MOCK_CLAUDE;
  if (useMockClaude) {
    envVars.USE_MOCK_CLAUDE = useMockClaude;
  }

  // Add artifact configuration if present
  if (context.storageManifest?.artifact) {
    const artifact = context.storageManifest.artifact;
    envVars.VM0_ARTIFACT_DRIVER = "vas";
    envVars.VM0_ARTIFACT_MOUNT_PATH = artifact.mountPath;
    envVars.VM0_ARTIFACT_VOLUME_NAME = artifact.vasStorageName;
    envVars.VM0_ARTIFACT_VERSION_ID = artifact.vasVersionId;
  }

  // Add resume session ID if present
  if (context.resumeSession) {
    envVars.VM0_RESUME_SESSION_ID = context.resumeSession.sessionId;
  }

  // Add user environment variables
  if (context.environment) {
    Object.assign(envVars, context.environment);
  }

  // Add secret values for masking (base64 encoded, comma separated)
  if (context.secretValues && context.secretValues.length > 0) {
    envVars.VM0_SECRET_VALUES = context.secretValues
      .map((v) => Buffer.from(v).toString("base64"))
      .join(",");
  }

  // Add user-defined vars
  if (context.vars) {
    for (const [key, value] of Object.entries(context.vars)) {
      envVars[key] = value;
    }
  }

  // For MITM mode, tell Node.js to trust the proxy CA certificate
  // This is required because mitmproxy intercepts HTTPS traffic and re-signs
  // certificates with its own CA. Without this, Node.js will reject the connection.
  // Note: Python and curl automatically use the system CA bundle after update-ca-certificates.
  if (context.experimentalFirewall?.experimental_mitm) {
    envVars.NODE_EXTRA_CA_CERTS =
      "/usr/local/share/ca-certificates/vm0-proxy-ca.crt";
  }

  return envVars;
}

/**
 * Path to environment JSON file in VM
 * Used by run-agent.py to load environment variables
 */
const ENV_JSON_PATH = "/tmp/vm0-env.json";

/**
 * Network log entry from mitmproxy addon
 *
 * Supports two modes:
 * - sni: SNI-only mode (no HTTPS decryption, only host/port/action)
 * - mitm: MITM mode (full HTTP details including method, status, latency, sizes)
 */
interface NetworkLogEntry {
  timestamp: string;
  // Common fields (all modes)
  mode?: "mitm" | "sni";
  action?: "ALLOW" | "DENY";
  host?: string;
  port?: number;
  rule_matched?: string | null;
  // MITM-only fields (optional)
  method?: string;
  url?: string;
  status?: number;
  latency_ms?: number;
  request_size?: number;
  response_size?: number;
}

/**
 * Get the network log file path for a run
 */
function getNetworkLogPath(runId: string): string {
  return `/tmp/vm0-network-${runId}.jsonl`;
}

/**
 * Read network logs from the JSONL file
 */
function readNetworkLogs(runId: string): NetworkLogEntry[] {
  const logPath = getNetworkLogPath(runId);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    return lines.map((line) => JSON.parse(line) as NetworkLogEntry);
  } catch (err) {
    console.error(
      `[Executor] Failed to read network logs: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    return [];
  }
}

/**
 * Delete network log file after upload
 */
function cleanupNetworkLogs(runId: string): void {
  const logPath = getNetworkLogPath(runId);

  try {
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  } catch (err) {
    console.error(
      `[Executor] Failed to cleanup network logs: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

/**
 * Upload network logs to telemetry endpoint
 */
async function uploadNetworkLogs(
  apiUrl: string,
  sandboxToken: string,
  runId: string,
): Promise<void> {
  const networkLogs = readNetworkLogs(runId);

  if (networkLogs.length === 0) {
    console.log(`[Executor] No network logs to upload for ${runId}`);
    return;
  }

  console.log(
    `[Executor] Uploading ${networkLogs.length} network log entries for ${runId}`,
  );

  const headers: Record<string, string> = {
    Authorization: `Bearer ${sandboxToken}`,
    "Content-Type": "application/json",
  };

  // Add Vercel bypass secret if available
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  const response = await fetch(`${apiUrl}/api/webhooks/agent/telemetry`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      runId,
      networkLogs,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Executor] Failed to upload network logs: ${errorText}`);
    return;
  }

  console.log(`[Executor] Network logs uploaded successfully for ${runId}`);

  // Cleanup log file after successful upload
  cleanupNetworkLogs(runId);
}

/**
 * Upload all scripts to VM individually via SSH
 * Scripts are installed to /usr/local/bin which requires sudo
 */
async function uploadScripts(ssh: SSHClient): Promise<void> {
  const scripts = getAllScripts();

  // Create directories first (requires sudo for /usr/local/bin)
  await ssh.execOrThrow(
    `sudo mkdir -p ${SCRIPT_PATHS.baseDir} ${SCRIPT_PATHS.libDir}`,
  );

  // Write each script file individually using sudo tee
  for (const script of scripts) {
    await ssh.writeFileWithSudo(script.path, script.content);
  }

  // Set executable permissions (requires sudo)
  await ssh.execOrThrow(
    `sudo chmod +x ${SCRIPT_PATHS.baseDir}/*.py ${SCRIPT_PATHS.libDir}/*.py 2>/dev/null || true`,
  );
}

/**
 * Download storages to VM using storage manifest
 */
async function downloadStorages(
  ssh: SSHClient,
  manifest: StorageManifest,
): Promise<void> {
  // Count archives to download
  const totalArchives =
    manifest.storages.filter((s) => s.archiveUrl).length +
    (manifest.artifact?.archiveUrl ? 1 : 0);

  if (totalArchives === 0) {
    console.log(`[Executor] No archives to download`);
    return;
  }

  console.log(`[Executor] Downloading ${totalArchives} archive(s)...`);

  // Write manifest to VM
  const manifestJson = JSON.stringify(manifest);
  await ssh.writeFile("/tmp/storage-manifest.json", manifestJson);

  // Run download script
  const result = await ssh.exec(
    `python3 ${SCRIPT_PATHS.download} /tmp/storage-manifest.json`,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Storage download failed: ${result.stderr}`);
  }

  console.log(`[Executor] Storage download completed`);
}

/**
 * Restore session history for resume functionality
 */
async function restoreSessionHistory(
  ssh: SSHClient,
  resumeSession: ResumeSession,
  workingDir: string,
  cliAgentType: string,
): Promise<void> {
  const { sessionId, sessionHistory } = resumeSession;

  // Calculate session history path based on CLI agent type
  let sessionPath: string;
  if (cliAgentType === "codex") {
    // Codex uses different path structure - for now use a marker
    // The checkpoint.py will search for the actual file
    console.log(
      `[Executor] Codex resume session will be handled by checkpoint.py`,
    );
    return;
  } else {
    // Claude Code path: ~/.claude/projects/-{path}/{session_id}.jsonl
    const projectName = workingDir.replace(/^\//, "").replace(/\//g, "-");
    sessionPath = `/home/user/.claude/projects/-${projectName}/${sessionId}.jsonl`;
  }

  console.log(`[Executor] Restoring session history to ${sessionPath}`);

  // Create directory and write file
  const dirPath = sessionPath.substring(0, sessionPath.lastIndexOf("/"));
  await ssh.execOrThrow(`mkdir -p "${dirPath}"`);
  await ssh.writeFile(sessionPath, sessionHistory);

  console.log(
    `[Executor] Session history restored (${sessionHistory.split("\n").length} lines)`,
  );
}

/**
 * Path to the proxy CA certificate on the runner host (cert only, no private key)
 */
const PROXY_CA_CERT_PATH = "/opt/vm0-runner/proxy/mitmproxy-ca-cert.pem";

/**
 * Install proxy CA certificate in VM for network security mode
 * This allows the VM to trust the runner's mitmproxy for HTTPS interception
 */
async function installProxyCA(ssh: SSHClient): Promise<void> {
  // Read CA certificate from runner host
  if (!fs.existsSync(PROXY_CA_CERT_PATH)) {
    throw new Error(
      `Proxy CA certificate not found at ${PROXY_CA_CERT_PATH}. Run generate-proxy-ca.sh first.`,
    );
  }

  const caCert = fs.readFileSync(PROXY_CA_CERT_PATH, "utf-8");
  console.log(
    `[Executor] Installing proxy CA certificate (${caCert.length} bytes)`,
  );

  // Write CA cert to VM's CA certificates directory
  await ssh.writeFileWithSudo(
    "/usr/local/share/ca-certificates/vm0-proxy-ca.crt",
    caCert,
  );

  // Update CA certificates (requires sudo)
  await ssh.execOrThrow("sudo update-ca-certificates");
  console.log(`[Executor] Proxy CA certificate installed successfully`);
}

/**
 * Configure DNS in the VM
 * Systemd-resolved may overwrite /etc/resolv.conf at boot,
 * so we need to ensure DNS servers are configured after SSH is ready.
 * Requires sudo since we're connected as 'user', not root.
 */
async function configureDNS(ssh: SSHClient): Promise<void> {
  // Remove any symlink and write static DNS configuration
  // Use sudo since /etc/resolv.conf requires root access
  const dnsConfig = `nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1`;

  await ssh.execOrThrow(
    `sudo sh -c 'rm -f /etc/resolv.conf && echo "${dnsConfig}" > /etc/resolv.conf'`,
  );
}

/**
 * Execute a job in a Firecracker VM
 */
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
    };

    // Create and start VM
    log(`[Executor] Creating VM ${vmId}...`);
    vm = new FirecrackerVM(vmConfig);
    await withSandboxTiming("vm_create", () => vm!.start());

    // Get VM IP for SSH connection
    guestIp = vm.getGuestIp();
    if (!guestIp) {
      throw new Error("VM started but no IP address available");
    }
    log(`[Executor] VM ${vmId} started, guest IP: ${guestIp}`);

    // Create SSH client and wait for SSH to become available
    // Connect as 'user' (not root) to match E2B behavior
    // Privileged operations use sudo
    const privateKeyPath = getRunnerSSHKeyPath();
    const ssh = createVMSSHClient(guestIp, "user", privateKeyPath || undefined);
    log(`[Executor] Waiting for SSH on ${guestIp}...`);
    await withSandboxTiming("ssh_wait", () =>
      ssh.waitUntilReachable(120000, 2000),
    ); // 2 minute timeout, check every 2s

    log(`[Executor] SSH ready on ${guestIp}`);

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
      await setupVMProxyRules(guestIp, config.proxy.port);

      // Register VM in the proxy registry with firewall rules
      getVMRegistry().register(guestIp, context.runId, context.sandboxToken, {
        firewallRules: firewallConfig?.rules,
        mitmEnabled,
        sealSecretsEnabled,
      });

      // Install proxy CA certificate only if MITM is enabled
      // For SNI-only mode (filter without MITM), we don't need CA
      if (mitmEnabled) {
        await installProxyCA(ssh);
      }
    }

    // Configure DNS - systemd may have overwritten resolv.conf at boot
    log(`[Executor] Configuring DNS...`);
    await configureDNS(ssh);

    // Upload all Python scripts
    log(`[Executor] Uploading scripts...`);
    await withSandboxTiming("script_upload", () => uploadScripts(ssh));
    log(`[Executor] Scripts uploaded to ${SCRIPT_PATHS.baseDir}`);

    // Download storages if manifest provided
    if (context.storageManifest) {
      await withSandboxTiming("storage_download", () =>
        downloadStorages(ssh, context.storageManifest!),
      );
    }

    // Restore session history if resuming
    if (context.resumeSession) {
      await withSandboxTiming("session_restore", () =>
        restoreSessionHistory(
          ssh,
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
    await ssh.writeFile(ENV_JSON_PATH, envJson);

    // Execute agent or direct command based on mode
    const systemLogFile = `/tmp/vm0-main-${context.runId}.log`;
    const exitCodeFile = `/tmp/vm0-exit-${context.runId}`;
    const startTime = Date.now();

    if (options.benchmarkMode) {
      // Benchmark mode: run prompt directly as bash command (skip run-agent.py)
      // This avoids API dependencies while still testing the full VM setup pipeline
      log(`[Executor] Running command directly (benchmark mode)...`);
      await ssh.exec(
        `nohup sh -c '${context.prompt}; echo $? > ${exitCodeFile}' > ${systemLogFile} 2>&1 &`,
      );
      log(`[Executor] Command started in background`);
    } else {
      // Production mode: run env-loader.py which loads environment and runs run-agent.py
      log(`[Executor] Running agent via env-loader (background)...`);
      await ssh.exec(
        `nohup sh -c 'python3 -u ${ENV_LOADER_PATH}; echo $? > ${exitCodeFile}' > ${systemLogFile} 2>&1 &`,
      );
      log(`[Executor] Agent started in background`);
    }

    // Poll for completion by checking if exit code file exists
    // Timeout after 24 hours (same as E2B sandbox timeout)
    const pollIntervalMs = 2000; // Check every 2 seconds
    const maxWaitMs = 24 * 60 * 60 * 1000; // 24 hours max
    let exitCode = 1;
    let completed = false;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      // Check if exit code file exists
      const checkResult = await ssh.exec(`cat ${exitCodeFile} 2>/dev/null`);
      if (checkResult.exitCode === 0 && checkResult.stdout.trim()) {
        const parsed = parseInt(checkResult.stdout.trim(), 10);
        exitCode = Number.isNaN(parsed) ? 1 : parsed;
        completed = true;
        break;
      }

      // Check if agent process is still running (production mode only)
      // If exit code file doesn't exist but process is dead, agent crashed unexpectedly
      if (!options.benchmarkMode) {
        const processCheck = await ssh.exec(
          `pgrep -f "env-loader.py" > /dev/null 2>&1 && echo "RUNNING" || echo "DEAD"`,
        );

        if (processCheck.stdout.trim() === "DEAD") {
          // Process is dead but no exit code file - agent crashed unexpectedly
          log(
            `[Executor] Agent process died unexpectedly without writing exit code`,
          );

          // Try to get diagnostic info from system log and dmesg
          const logContent = await ssh.exec(
            `tail -50 ${systemLogFile} 2>/dev/null`,
          );
          const dmesgCheck = await ssh.exec(
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
    const logResult = await ssh.exec(`tail -100 ${systemLogFile} 2>/dev/null`);
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
        await removeVMProxyRules(guestIp, config.proxy.port);
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
