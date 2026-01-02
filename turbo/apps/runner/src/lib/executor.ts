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
import { type VsockClient, createVMVsockClient } from "./firecracker/vsock.js";
import type {
  ExecutionContext,
  StorageManifest,
  ResumeSession,
} from "./api.js";
import type { RunnerConfig } from "./config.js";
import { getAllScripts, createScriptsTarBuffer } from "./scripts/tar.js";
import { SCRIPT_PATHS } from "./scripts/index.js";

/**
 * Execution result
 */
export interface ExecutionResult {
  exitCode: number;
  error?: string;
}

/**
 * VM ID counter for unique TAP devices
 */
let vmIdCounter = 0;

/**
 * Get next VM ID
 */
function getNextVmId(): number {
  return ++vmIdCounter;
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
 * Build environment export string for shell execution
 */
function buildEnvExports(envVars: Record<string, string>): string {
  return Object.entries(envVars)
    .map(([key, value]) => {
      // Escape single quotes in value
      const escapedValue = value.replace(/'/g, "'\"'\"'");
      return `export ${key}='${escapedValue}'`;
    })
    .join(" && ");
}

/**
 * Configure DNS in the VM
 * Uses Google Public DNS and Cloudflare DNS for reliability
 */
async function configureDNS(vsock: VsockClient): Promise<void> {
  // Write resolv.conf with public DNS servers
  await vsock.execOrThrow(
    `echo "nameserver 8.8.8.8" > /etc/resolv.conf && ` +
      `echo "nameserver 8.8.4.4" >> /etc/resolv.conf && ` +
      `echo "nameserver 1.1.1.1" >> /etc/resolv.conf`,
  );
}

/**
 * Upload all scripts to VM via tar archive
 */
async function uploadScripts(vsock: VsockClient): Promise<void> {
  // Get all scripts and create tar buffer
  const scripts = getAllScripts();
  const tarBuffer = createScriptsTarBuffer(scripts);

  // Write tar archive to VM
  await vsock.writeFile("/tmp/vm0-scripts.tar", tarBuffer.toString("base64"));

  // Decode base64, extract, and set permissions
  await vsock.execOrThrow(
    `base64 -d /tmp/vm0-scripts.tar > /tmp/vm0-scripts-decoded.tar && ` +
      `mkdir -p ${SCRIPT_PATHS.baseDir} ${SCRIPT_PATHS.libDir} && ` +
      `cd / && tar xf /tmp/vm0-scripts-decoded.tar && ` +
      `chmod +x ${SCRIPT_PATHS.baseDir}/*.py ${SCRIPT_PATHS.libDir}/*.py 2>/dev/null || true && ` +
      `rm -f /tmp/vm0-scripts.tar /tmp/vm0-scripts-decoded.tar`,
  );
}

/**
 * Download storages to VM using storage manifest
 */
async function downloadStorages(
  vsock: VsockClient,
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
  await vsock.writeFile("/tmp/storage-manifest.json", manifestJson);

  // Run download script
  const result = await vsock.exec(
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
  vsock: VsockClient,
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
  await vsock.execOrThrow(`mkdir -p "${dirPath}"`);
  await vsock.writeFile(sessionPath, sessionHistory);

  console.log(
    `[Executor] Session history restored (${sessionHistory.split("\n").length} lines)`,
  );
}

/**
 * Execute a job in a Firecracker VM
 */
export async function executeJob(
  context: ExecutionContext,
  config: RunnerConfig,
): Promise<ExecutionResult> {
  const vmId = getNextVmId();
  let vm: FirecrackerVM | null = null;
  let vsock: VsockClient | null = null;

  console.log(`[Executor] Starting job ${context.runId} in VM ${vmId}`);

  try {
    // Create VM configuration
    const vmConfig: VMConfig = {
      vmId,
      vcpus: config.sandbox.vcpu,
      memoryMb: config.sandbox.memory_mb,
      kernelPath: config.firecracker.kernel,
      rootfsPath: config.firecracker.rootfs,
      firecrackerBinary: config.firecracker.binary,
    };

    // Create and start VM
    console.log(`[Executor] Creating VM ${vmId}...`);
    vm = new FirecrackerVM(vmConfig);
    await vm.start();

    // Get vsock path for host-guest communication
    const vsockPath = vm.getVsockPath();
    console.log(`[Executor] VM ${vmId} started, vsock at ${vsockPath}`);

    // Create vsock client and wait for vm0-agent to be reachable
    vsock = createVMVsockClient(vsockPath);
    console.log(`[Executor] Waiting for vm0-agent on vsock...`);
    await vsock.waitUntilReachable(120000, 2000); // 2 minute timeout, check every 2s

    console.log(`[Executor] vm0-agent ready on vsock`);

    // Configure DNS for network access
    console.log(`[Executor] Configuring DNS...`);
    await configureDNS(vsock);

    // Upload all Python scripts via tar archive
    console.log(`[Executor] Uploading scripts...`);
    await uploadScripts(vsock);
    console.log(`[Executor] Scripts uploaded to ${SCRIPT_PATHS.baseDir}`);

    // Download storages if manifest provided
    if (context.storageManifest) {
      await downloadStorages(vsock, context.storageManifest);
    }

    // Restore session history if resuming
    if (context.resumeSession) {
      await restoreSessionHistory(
        vsock,
        context.resumeSession,
        context.workingDir,
        context.cliAgentType || "claude-code",
      );
    }

    // Build environment variables
    const envVars = buildEnvironmentVariables(context);
    const envExports = buildEnvExports(envVars);

    // Execute run-agent.py
    console.log(`[Executor] Running agent...`);
    const startTime = Date.now();

    const result = await vsock.exec(
      `${envExports} && python3 -u ${SCRIPT_PATHS.runAgent}`,
    );

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `[Executor] Agent finished in ${duration}s with exit code ${result.exitCode}`,
    );

    // Log output for debugging
    if (result.stdout) {
      console.log(`[Executor] stdout: ${result.stdout.substring(0, 500)}...`);
    }
    if (result.stderr) {
      console.log(`[Executor] stderr: ${result.stderr.substring(0, 500)}...`);
    }

    return {
      exitCode: result.exitCode,
      error: result.exitCode !== 0 ? result.stderr || undefined : undefined,
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
