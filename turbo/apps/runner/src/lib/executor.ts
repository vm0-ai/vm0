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
import { FirecrackerVM, type VMConfig } from "./firecracker/vm.js";
import {
  type SSHClient,
  createVMSSHClient,
  getRunnerSSHKeyPath,
} from "./firecracker/guest.js";
import type {
  ExecutionContext,
  StorageManifest,
  ResumeSession,
} from "./api.js";
import type { RunnerConfig } from "./config.js";
import { getAllScripts } from "./scripts/utils.js";
import { SCRIPT_PATHS, ENV_LOADER_PATH } from "./scripts/index.js";

/**
 * Execution result
 */
export interface ExecutionResult {
  exitCode: number;
  error?: string;
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
): Record<string, string> {
  const envVars: Record<string, string> = {
    VM0_API_URL: context.apiUrl,
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

  return envVars;
}

/**
 * Path to environment JSON file in VM
 * Used by run-agent.py to load environment variables
 */
const ENV_JSON_PATH = "/tmp/vm0-env.json";

/**
 * Upload all scripts to VM individually via SSH
 */
async function uploadScripts(ssh: SSHClient): Promise<void> {
  const scripts = getAllScripts();

  // Create directories first
  await ssh.execOrThrow(
    `mkdir -p ${SCRIPT_PATHS.baseDir} ${SCRIPT_PATHS.libDir}`,
  );

  // Write each script file individually
  for (const script of scripts) {
    await ssh.writeFile(script.path, script.content);
  }

  // Set executable permissions
  await ssh.execOrThrow(
    `chmod +x ${SCRIPT_PATHS.baseDir}/*.py ${SCRIPT_PATHS.libDir}/*.py 2>/dev/null || true`,
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
 * Configure DNS in the VM
 * Systemd-resolved may overwrite /etc/resolv.conf at boot,
 * so we need to ensure DNS servers are configured after SSH is ready.
 */
async function configureDNS(ssh: SSHClient): Promise<void> {
  // Remove any symlink and write static DNS configuration
  const dnsConfig = `nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1`;

  await ssh.execOrThrow(
    `rm -f /etc/resolv.conf && echo '${dnsConfig}' > /etc/resolv.conf`,
  );
}

/**
 * Execute a job in a Firecracker VM
 */
export async function executeJob(
  context: ExecutionContext,
  config: RunnerConfig,
): Promise<ExecutionResult> {
  // Use runId (UUID) to derive unique VM identifier
  // This ensures no conflicts even across process restarts
  const vmId = getVmIdFromRunId(context.runId);
  let vm: FirecrackerVM | null = null;

  console.log(`[Executor] Starting job ${context.runId} in VM ${vmId}`);

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
    console.log(`[Executor] Creating VM ${vmId}...`);
    vm = new FirecrackerVM(vmConfig);
    await vm.start();

    // Get VM IP for SSH connection
    const guestIp = vm.getGuestIp();
    if (!guestIp) {
      throw new Error("VM started but no IP address available");
    }
    console.log(`[Executor] VM ${vmId} started, guest IP: ${guestIp}`);

    // Create SSH client and wait for SSH to become available
    const privateKeyPath = getRunnerSSHKeyPath();
    const ssh = createVMSSHClient(guestIp, "root", privateKeyPath || undefined);
    console.log(`[Executor] Waiting for SSH on ${guestIp}...`);
    await ssh.waitUntilReachable(120000, 2000); // 2 minute timeout, check every 2s

    console.log(`[Executor] SSH ready on ${guestIp}`);

    // Configure DNS - systemd may have overwritten resolv.conf at boot
    console.log(`[Executor] Configuring DNS...`);
    await configureDNS(ssh);

    // Upload all Python scripts
    console.log(`[Executor] Uploading scripts...`);
    await uploadScripts(ssh);
    console.log(`[Executor] Scripts uploaded to ${SCRIPT_PATHS.baseDir}`);

    // Download storages if manifest provided
    if (context.storageManifest) {
      await downloadStorages(ssh, context.storageManifest);
    }

    // Restore session history if resuming
    if (context.resumeSession) {
      await restoreSessionHistory(
        ssh,
        context.resumeSession,
        context.workingDir,
        context.cliAgentType || "claude-code",
      );
    }

    // Build environment variables and write as JSON file in VM
    // Using JSON avoids shell escaping issues entirely - Python loads it directly
    const envVars = buildEnvironmentVariables(context);
    const envJson = JSON.stringify(envVars);
    console.log(
      `[Executor] Writing env JSON (${envJson.length} bytes) to ${ENV_JSON_PATH}`,
    );
    await ssh.writeFile(ENV_JSON_PATH, envJson);

    // Execute env-loader.py which loads environment from JSON, then runs run-agent.py
    // Redirect output to system log file so telemetry can upload it
    // Use shell construct to preserve exit code while redirecting
    const systemLogFile = `/tmp/vm0-main-${context.runId}.log`;
    console.log(`[Executor] Running agent via env-loader...`);
    const startTime = Date.now();

    // Run with output redirected to log file, capturing exit code via shell
    // The { cmd; } construct allows us to redirect all output while preserving exit code
    const result = await ssh.exec(
      `{ python3 -u ${ENV_LOADER_PATH}; } > ${systemLogFile} 2>&1; echo "EXIT_CODE:$?"`,
    );

    // Parse exit code from the output (last line is "EXIT_CODE:N")
    const lines = result.stdout.trim().split("\n");
    const exitCodeLine = lines[lines.length - 1] ?? "";
    const exitCodeMatch = exitCodeLine.match(/EXIT_CODE:(\d+)/);
    const exitCode =
      exitCodeMatch && exitCodeMatch[1] ? parseInt(exitCodeMatch[1], 10) : 1;

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `[Executor] Agent finished in ${duration}s with exit code ${exitCode}`,
    );

    // Read log file for debugging output
    const logResult = await ssh.exec(`tail -100 ${systemLogFile} 2>/dev/null`);
    if (logResult.stdout) {
      console.log(
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
    // Always cleanup VM
    if (vm) {
      console.log(`[Executor] Cleaning up VM ${vmId}...`);
      try {
        await vm.kill();
      } catch (error) {
        console.error(
          `[Executor] Failed to cleanup VM ${vmId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
