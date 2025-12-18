import { Sandbox } from "@e2b/code-interpreter";
import { e2bConfig } from "./config";
import type { RunResult } from "./types";
import { storageService } from "../storage/storage-service";
import { BadRequestError } from "../errors";
import { resolveImageAlias } from "../image/image-service";
import type {
  AgentVolumeConfig,
  PreparedArtifact,
  StorageManifest,
} from "../storage/types";
import type { AgentComposeYaml } from "../../types/agent-compose";
import {
  INIT_SCRIPT,
  COMMON_SCRIPT,
  LOG_SCRIPT,
  HTTP_SCRIPT,
  EVENTS_SCRIPT,
  DIRECT_UPLOAD_SCRIPT,
  DOWNLOAD_SCRIPT,
  CHECKPOINT_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  METRICS_SCRIPT,
  UPLOAD_TELEMETRY_SCRIPT,
  PROXY_SETUP_SCRIPT,
  MITM_ADDON_SCRIPT,
  RUN_AGENT_SCRIPT,
  SCRIPT_PATHS,
} from "./scripts";
import type { ExecutionContext } from "../run/types";
import { calculateSessionHistoryPath } from "../run/run-service";
import { logger } from "../logger";
import { agentRuns } from "../../db/schema/agent-run";
import { eq } from "drizzle-orm";

const log = logger("service:e2b");

/**
 * Get the first agent from compose (currently only one agent is supported)
 */
function getFirstAgent(
  compose?: AgentComposeYaml,
): AgentComposeYaml["agents"][string] | undefined {
  if (!compose?.agents) return undefined;
  const values = Object.values(compose.agents);
  return values[0];
}

/**
 * E2B Service
 * Manages E2B sandbox creation and execution
 * Agnostic to run type (new run or resume)
 */
export class E2BService {
  /**
   * Execute an agent run with the given context
   * Works for both new runs and resumed runs
   *
   * @param context Execution context containing all necessary information
   * @returns Run result
   */
  async execute(context: ExecutionContext): Promise<RunResult> {
    const startTime = Date.now();
    const isResume = !!context.resumeSession;

    log.debug(
      `${isResume ? "Resuming" : "Creating"} run ${context.runId} for agent version ${context.agentComposeVersionId}...`,
    );
    log.debug(
      `context.volumeVersions=${JSON.stringify(context.volumeVersions)}`,
    );

    let sandbox: Sandbox | null = null;
    const agentCompose = context.agentCompose as AgentVolumeConfig | undefined;
    const agentComposeYaml = context.agentCompose as
      | AgentComposeYaml
      | undefined;

    try {
      // Get mount path from agent compose (used for resume artifact)
      // working_dir is required - no fallback allowed
      const firstAgent = getFirstAgent(agentComposeYaml);
      if (!firstAgent?.working_dir) {
        throw new BadRequestError(
          "Agent must have working_dir configured (no default allowed)",
        );
      }
      const artifactMountPath = firstAgent.working_dir;
      // Prepare storage manifest with presigned URLs for direct download to sandbox
      // This works for both new runs and resume scenarios
      const storageManifest = await storageService.prepareStorageManifest(
        agentCompose,
        context.vars || {},
        context.userId || "",
        context.artifactName,
        context.artifactVersion,
        context.volumeVersions,
        context.resumeArtifact, // For resume: use artifact from checkpoint snapshot
        artifactMountPath,
      );

      // Create artifact info for checkpoint
      const artifactForCommand: PreparedArtifact | null =
        storageManifest.artifact
          ? {
              driver: "vas",
              mountPath: storageManifest.artifact.mountPath,
              vasStorageName: storageManifest.artifact.vasStorageName,
              vasVersionId: storageManifest.artifact.vasVersionId,
              manifestUrl: storageManifest.artifact.manifestUrl,
            }
          : null;

      // Get API configuration with dynamic fallback logic
      // Priority: explicit VM0_API_URL > VERCEL_URL (for preview) > production URL > localhost
      const envVars = globalThis.services?.env;

      // Read Vercel system variables directly from process.env
      // These may not be available through the validated env schema
      const vercelEnv = process.env.VERCEL_ENV;
      const vercelUrl = process.env.VERCEL_URL;

      let apiUrl = envVars?.VM0_API_URL || process.env.VM0_API_URL;

      if (!apiUrl) {
        // If no explicit URL, determine based on VERCEL_ENV
        if (vercelEnv === "preview" && vercelUrl) {
          apiUrl = `https://${vercelUrl}`;
        } else if (vercelEnv === "production") {
          apiUrl = "https://www.vm0.ai";
        } else {
          apiUrl = "http://localhost:3000";
        }
      }

      const webhookEndpoint = `${apiUrl}/api/webhooks/agent/events`;

      log.debug(
        `Environment - VERCEL_ENV: ${vercelEnv}, VERCEL_URL: ${vercelUrl}, VM0_API_URL: ${apiUrl}`,
      );
      log.debug(`Computed API URL: ${apiUrl}`);
      log.debug(`Webhook: ${webhookEndpoint}`);

      // Create E2B sandbox with environment variables
      const sandboxEnvVars: Record<string, string> = {
        VM0_API_URL: apiUrl,
        VM0_RUN_ID: context.runId,
        VM0_API_TOKEN: context.sandboxToken, // Temporary bearer token for webhook authentication
      };

      // Add Vercel protection bypass secret if available (for preview deployments)
      const vercelBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      if (vercelBypassSecret) {
        sandboxEnvVars.VERCEL_PROTECTION_BYPASS = vercelBypassSecret;
        log.debug(`Added Vercel protection bypass for preview deployment`);
      }

      // Add prompt and working directory to sandbox env vars
      // These must be set at sandbox creation time, not via commands.run({ envs })
      // because E2B's background mode doesn't pass envs to the background process
      sandboxEnvVars.VM0_PROMPT = context.prompt;
      sandboxEnvVars.VM0_WORKING_DIR = artifactMountPath;

      // Add resume session ID if provided
      if (context.resumeSession?.sessionId) {
        sandboxEnvVars.VM0_RESUME_SESSION_ID = context.resumeSession.sessionId;
      }

      // Pass USE_MOCK_CLAUDE for testing (executes prompt as bash instead of calling LLM)
      if (process.env.USE_MOCK_CLAUDE === "true") {
        sandboxEnvVars.USE_MOCK_CLAUDE = "true";
      }

      // Enable proxy mode for network security
      // When true, mitmproxy will be set up to intercept traffic
      // and decrypt vm0_enc_ tokens before forwarding to APIs
      if (context.betaNetworkSecurity) {
        sandboxEnvVars.VM0_PROXY_ENABLED = "true";
        // Set SSL certificate environment variables for mitmproxy CA
        // These ensure Python's requests/urllib and other libraries trust the proxy CA
        sandboxEnvVars.REQUESTS_CA_BUNDLE =
          "/etc/ssl/certs/ca-certificates.crt";
        sandboxEnvVars.SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
        sandboxEnvVars.CURL_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
        // Node.js also needs the CA cert
        sandboxEnvVars.NODE_EXTRA_CA_CERTS =
          "/etc/ssl/certs/ca-certificates.crt";
        log.debug(
          `Network security enabled for run ${context.runId} - proxy mode active`,
        );
      }

      // Add artifact information for checkpoint
      // Only artifact creates new versions after agent runs
      if (artifactForCommand) {
        sandboxEnvVars.VM0_ARTIFACT_DRIVER = "vas";
        sandboxEnvVars.VM0_ARTIFACT_MOUNT_PATH = artifactForCommand.mountPath;
        sandboxEnvVars.VM0_ARTIFACT_VOLUME_NAME =
          artifactForCommand.vasStorageName;
        sandboxEnvVars.VM0_ARTIFACT_VERSION_ID =
          artifactForCommand.vasVersionId;
      }

      // Add user-defined environment variables (expanded from ${{ vars.X }} by server)
      if (context.environment) {
        for (const [key, value] of Object.entries(context.environment)) {
          sandboxEnvVars[key] = value;
        }
        log.debug(
          `Added ${Object.keys(context.environment).length} user-defined environment variables`,
        );
      }

      sandbox = await this.createSandbox(
        sandboxEnvVars,
        agentCompose as AgentComposeYaml | undefined,
        context.userId || "",
      );
      log.debug(`Sandbox created: ${sandbox.sandboxId}`);

      // Update sandboxId in database immediately after creation
      // This MUST happen BEFORE startAgentExecution() to avoid race condition
      // where complete webhook arrives before sandboxId is persisted
      await globalThis.services.db
        .update(agentRuns)
        .set({ sandboxId: sandbox.sandboxId })
        .where(eq(agentRuns.id, context.runId));
      log.debug(
        `SandboxId ${sandbox.sandboxId} persisted to database for run ${context.runId}`,
      );

      // Upload all scripts to sandbox via single tar archive
      // This is done ONCE before any other operations to minimize E2B API calls
      log.debug(`[${context.runId}] Uploading scripts to sandbox...`);
      await this.uploadAllScripts(sandbox);
      log.debug(`[${context.runId}] Scripts uploaded successfully`);

      // Download storages directly to sandbox via presigned URLs
      // Scripts are already available from uploadAllScripts()
      log.debug(`[${context.runId}] Downloading storages to sandbox...`);
      await this.downloadStoragesDirectly(sandbox, storageManifest);
      log.debug(`[${context.runId}] Storages downloaded successfully`);

      // Restore session history for resume
      if (context.resumeSession) {
        await this.restoreSessionHistory(
          sandbox,
          context.resumeSession.sessionId,
          context.resumeSession.sessionHistory,
          context.resumeSession.workingDir,
        );
      }

      // Start Claude Code via run-agent.sh (fire-and-forget)
      // The script will send events via webhook and update status when complete
      // NOTE: All env vars are already set at sandbox creation time, scripts already uploaded
      log.debug(`[${context.runId}] Starting agent execution...`);
      await this.startAgentExecution(
        sandbox,
        context.runId,
        context.betaNetworkSecurity || false,
      );
      log.debug(`[${context.runId}] Agent execution command sent`);

      const prepTimeMs = Date.now() - startTime;
      log.debug(
        `Run ${context.runId} sandbox prepared in ${prepTimeMs}ms, agent execution started (fire-and-forget)`,
      );

      // Return immediately with "running" status
      // Final status will be updated by webhook when run-agent.sh completes
      return {
        runId: context.runId,
        sandboxId: sandbox.sandboxId,
        status: "running",
        output: "",
        executionTimeMs: prepTimeMs,
        createdAt: new Date(startTime),
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const completedAt = new Date();

      // Extract error message - E2B CommandExitError includes result with stderr
      let errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Check if error has result property (E2B CommandExitError)
      const errorWithResult = error as { result?: { stderr?: string } };
      if (errorWithResult.result?.stderr) {
        errorMessage = errorWithResult.result.stderr;
        log.error(`Run ${context.runId} failed with stderr:`, errorMessage);
      } else {
        log.error(`Run ${context.runId} failed:`, error);
      }

      // Update run status to failed in database
      try {
        await globalThis.services.db
          .update(agentRuns)
          .set({
            status: "failed",
            completedAt: new Date(),
            error: errorMessage,
          })
          .where(eq(agentRuns.id, context.runId));
      } catch (e) {
        log.error(`Failed to update run status for ${context.runId}:`, e);
      }

      // Cleanup sandbox on preparation failure
      if (sandbox) {
        await this.cleanupSandbox(sandbox);
      }

      return {
        runId: context.runId,
        sandboxId: sandbox?.sandboxId || "unknown",
        status: "failed",
        output: "",
        error: errorMessage,
        executionTimeMs,
        createdAt: new Date(startTime),
        completedAt,
      };
    }
    // Note: No finally cleanup - sandbox continues running for fire-and-forget execution
    // Sandbox will auto-terminate after timeout (24h production, 1h other) or when run-agent.sh completes
  }

  /**
   * Restore session history for resume functionality
   * Writes session history JSONL file to correct location for Claude Code to detect
   *
   * @param sandbox E2B sandbox instance
   * @param sessionId Session ID to restore
   * @param sessionHistory JSONL content of session history
   * @param workingDir Working directory for path calculation
   */
  private async restoreSessionHistory(
    sandbox: Sandbox,
    sessionId: string,
    sessionHistory: string,
    workingDir: string,
  ): Promise<void> {
    log.debug(`Restoring session history for ${sessionId}...`);

    // Calculate session history path using same logic as run-agent-script
    const sessionHistoryPath = calculateSessionHistoryPath(
      workingDir,
      sessionId,
    );

    log.debug(`Session history path: ${sessionHistoryPath}`);

    // Create directory structure
    const dirPath = sessionHistoryPath.substring(
      0,
      sessionHistoryPath.lastIndexOf("/"),
    );
    await sandbox.commands.run(`mkdir -p "${dirPath}"`);

    // Write session history file
    const sessionBuffer = Buffer.from(sessionHistory, "utf-8");
    const arrayBuffer = sessionBuffer.buffer.slice(
      sessionBuffer.byteOffset,
      sessionBuffer.byteOffset + sessionBuffer.byteLength,
    ) as ArrayBuffer;

    await sandbox.files.write(sessionHistoryPath, arrayBuffer);

    log.debug(
      `Session history restored (${sessionHistory.split("\n").length} lines)`,
    );
  }

  /**
   * Create E2B sandbox with Claude Code and environment variables
   * @param envVars Environment variables to pass to sandbox
   * @param agentCompose Agent compose containing image specification
   * @param userId User ID for resolving user-owned images
   */
  private async createSandbox(
    envVars: Record<string, string>,
    agentCompose: AgentComposeYaml | undefined,
    userId: string,
  ): Promise<Sandbox> {
    // Use 24 hour timeout for Vercel production, 1 hour for other environments
    const isVercelProduction = process.env.VERCEL_ENV === "production";
    const timeoutMs = isVercelProduction ? 86_400_000 : 3_600_000;

    const sandboxOptions = {
      timeoutMs,
      envs: envVars, // Pass environment variables to sandbox
    };

    // Priority: agent.image > E2B_TEMPLATE_NAME
    const agent = getFirstAgent(agentCompose);
    const imageAlias = agent?.image || e2bConfig.defaultTemplate;

    if (!imageAlias) {
      throw new Error(
        "[E2B] No template specified. Either set agent.image in vm0.config.yaml or E2B_TEMPLATE_NAME environment variable.",
      );
    }

    // Resolve user image aliases to E2B template names
    // System templates (vm0-*) pass through unchanged
    // User images (my-agent) resolve to user-{userId}-my-agent
    // Throws NotFoundError or BadRequestError if image is invalid
    const resolved = await resolveImageAlias(userId, imageAlias);
    const templateName = resolved.templateName;

    log.debug(`Using template: ${templateName}`);
    log.debug(
      `Template source: ${agent?.image ? "agent.image" : "E2B_TEMPLATE_NAME"}, isUserImage: ${resolved.isUserImage}`,
    );
    log.debug(
      `Sandbox timeout: ${timeoutMs / 3_600_000}h (VERCEL_ENV=${process.env.VERCEL_ENV || "undefined"})`,
    );
    log.debug(`Sandbox env vars:`, Object.keys(envVars));

    const sandbox = await Sandbox.create(templateName, sandboxOptions);
    return sandbox;
  }

  /**
   * Define all scripts that need to be uploaded to the sandbox
   * Scripts are split into single-responsibility Python modules for better maintainability
   */
  private getAllScripts(): Array<{ content: string; path: string }> {
    return [
      { content: INIT_SCRIPT, path: SCRIPT_PATHS.libInit },
      { content: COMMON_SCRIPT, path: SCRIPT_PATHS.common },
      { content: LOG_SCRIPT, path: SCRIPT_PATHS.log },
      { content: HTTP_SCRIPT, path: SCRIPT_PATHS.httpClient },
      { content: EVENTS_SCRIPT, path: SCRIPT_PATHS.events },
      { content: DIRECT_UPLOAD_SCRIPT, path: SCRIPT_PATHS.directUpload },
      { content: DOWNLOAD_SCRIPT, path: SCRIPT_PATHS.download },
      { content: CHECKPOINT_SCRIPT, path: SCRIPT_PATHS.checkpoint },
      { content: MOCK_CLAUDE_SCRIPT, path: SCRIPT_PATHS.mockClaude },
      { content: METRICS_SCRIPT, path: SCRIPT_PATHS.metrics },
      { content: UPLOAD_TELEMETRY_SCRIPT, path: SCRIPT_PATHS.uploadTelemetry },
      { content: PROXY_SETUP_SCRIPT, path: SCRIPT_PATHS.proxySetup },
      { content: MITM_ADDON_SCRIPT, path: SCRIPT_PATHS.mitmAddon },
      { content: RUN_AGENT_SCRIPT, path: SCRIPT_PATHS.runAgent },
    ];
  }

  /**
   * Create a tar archive containing all scripts with correct paths
   * This reduces E2B API calls from O(n) to O(1) for script uploads
   *
   * TAR format (POSIX ustar):
   * - Each file: 512-byte header + content padded to 512-byte boundary
   * - End: Two 512-byte zero blocks
   */
  private createScriptsTarBuffer(
    scripts: Array<{ content: string; path: string }>,
  ): Buffer {
    const BLOCK_SIZE = 512;
    const blocks: Buffer[] = [];

    for (const script of scripts) {
      const content = Buffer.from(script.content, "utf-8");
      // Remove leading slash for tar path
      const path = script.path.startsWith("/")
        ? script.path.slice(1)
        : script.path;

      // Create 512-byte tar header
      const header = Buffer.alloc(BLOCK_SIZE, 0);

      // File name (100 bytes, position 0)
      header.write(path, 0, 100, "utf-8");

      // File mode (8 bytes, position 100) - 0755 for executable
      header.write("0000755\0", 100, 8, "utf-8");

      // Owner UID (8 bytes, position 108) - 0
      header.write("0000000\0", 108, 8, "utf-8");

      // Owner GID (8 bytes, position 116) - 0
      header.write("0000000\0", 116, 8, "utf-8");

      // File size in octal (12 bytes, position 124)
      const sizeOctal = content.length.toString(8).padStart(11, "0");
      header.write(sizeOctal + "\0", 124, 12, "utf-8");

      // Modification time (12 bytes, position 136) - current time
      const mtime = Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, "0");
      header.write(mtime + "\0", 136, 12, "utf-8");

      // Checksum placeholder (8 bytes, position 148) - spaces for calculation
      header.write("        ", 148, 8, "utf-8");

      // Type flag (1 byte, position 156) - '0' for regular file
      header.write("0", 156, 1, "utf-8");

      // Link name (100 bytes, position 157) - empty
      // Already zero-filled

      // USTAR magic (6 bytes, position 257)
      header.write("ustar\0", 257, 6, "utf-8");

      // USTAR version (2 bytes, position 263)
      header.write("00", 263, 2, "utf-8");

      // Owner name (32 bytes, position 265)
      header.write("root", 265, 32, "utf-8");

      // Group name (32 bytes, position 297)
      header.write("root", 297, 32, "utf-8");

      // Calculate checksum (sum of all bytes in header, treating checksum field as spaces)
      let checksum = 0;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        checksum += header.readUInt8(i);
      }
      // Write checksum in octal (6 digits + null + space)
      const checksumStr = checksum.toString(8).padStart(6, "0");
      header.write(checksumStr + "\0 ", 148, 8, "utf-8");

      blocks.push(header);

      // Add content
      blocks.push(content);

      // Pad content to 512-byte boundary
      const padding = BLOCK_SIZE - (content.length % BLOCK_SIZE);
      if (padding < BLOCK_SIZE) {
        blocks.push(Buffer.alloc(padding, 0));
      }
    }

    // Add two empty blocks to mark end of archive
    blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

    return Buffer.concat(blocks);
  }

  /**
   * Upload all scripts to sandbox using a single tar archive
   * This significantly reduces E2B API calls:
   * - Before: 2 mkdir + 12 files.write + 12 commands.run = 26 E2B calls
   * - After: 1 files.write + 1 commands.run = 2 E2B calls
   *
   * @param sandbox E2B sandbox instance
   * @returns Path to the main run-agent.sh script
   */
  private async uploadAllScripts(sandbox: Sandbox): Promise<string> {
    const scripts = this.getAllScripts();

    // Create tar archive containing all scripts (synchronous, no I/O)
    const tarBuffer = this.createScriptsTarBuffer(scripts);
    const tarPath = "/tmp/vm0-scripts.tar";

    // Convert Buffer to ArrayBuffer for E2B
    const arrayBuffer = tarBuffer.buffer.slice(
      tarBuffer.byteOffset,
      tarBuffer.byteOffset + tarBuffer.byteLength,
    ) as ArrayBuffer;

    // Upload tar archive (single files.write call)
    await sandbox.files.write(tarPath, arrayBuffer);

    // Extract tar archive and set permissions (single commands.run call)
    // This creates directories, extracts files, and sets executable permissions for Python scripts
    await sandbox.commands.run(
      `sudo mkdir -p ${SCRIPT_PATHS.baseDir} ${SCRIPT_PATHS.libDir} && ` +
        `cd / && sudo tar xf ${tarPath} && ` +
        `sudo chmod +x ${SCRIPT_PATHS.baseDir}/*.py ${SCRIPT_PATHS.libDir}/*.py 2>/dev/null || true && ` +
        `rm -f ${tarPath}`,
    );

    log.debug(
      `Uploaded ${scripts.length} scripts via tar bundle to sandbox: ${SCRIPT_PATHS.baseDir}`,
    );
    return SCRIPT_PATHS.runAgent;
  }

  /**
   * Start agent execution (fire-and-forget)
   * Starts run-agent.sh in background without waiting
   * NOTE: Scripts must already be uploaded via uploadAllScripts() before calling this method
   *
   * NOTE: All environment variables must be set at sandbox creation time via createSandbox().
   * E2B's background mode does not pass envs from sandbox.commands.run({ envs }) to the process.
   */
  private async startAgentExecution(
    sandbox: Sandbox,
    runId: string,
    networkSecurityEnabled: boolean,
  ): Promise<void> {
    log.debug(`Starting run-agent.py for run ${runId} (fire-and-forget)...`);

    // Run proxy setup as root BEFORE starting agent if network security is enabled
    // This is done synchronously to ensure proxy is ready before agent starts
    // The agent then runs as default user ('user') for normal operation
    if (networkSecurityEnabled) {
      log.debug(`Running proxy setup as root for run ${runId}...`);
      const proxySetupCmd = `python3 ${SCRIPT_PATHS.libDir}/proxy_setup.py > /tmp/vm0-proxy-setup-${runId}.log 2>&1`;
      await sandbox.commands.run(proxySetupCmd, { user: "root" });
      log.debug(`Proxy setup completed for run ${runId}`);
    }

    // Start Python script in background using nohup to ignore SIGHUP signal
    // This prevents the process from being killed when E2B connection is closed
    // NOTE: Scripts already uploaded via uploadAllScripts(), do not pass envs here
    // Redirect output to per-run log file in /tmp with vm0- prefix
    //
    // NOTE: Agent runs as E2B default user ('user').
    // When network security is enabled, proxy setup is done as root before this.
    // mitmproxy also runs as root, and nftables skips root's traffic (meta skuid 0)
    // to avoid redirect loops.
    // Use python3 -u for unbuffered stdout/stderr to ensure logs are written immediately
    const cmd = `nohup python3 -u ${SCRIPT_PATHS.runAgent} > /tmp/vm0-main-${runId}.log 2>&1 &`;
    log.debug(`[${runId}] Executing background command: ${cmd}`);
    await sandbox.commands.run(cmd);
    log.debug(`[${runId}] Background command returned successfully`);
  }

  /**
   * Download storages directly to sandbox using presigned URLs
   * This method uploads a manifest file and runs a download script inside the sandbox
   * NOTE: Scripts must be uploaded first via uploadAllScripts()
   *
   * @param sandbox - E2B sandbox instance
   * @param manifest - Storage manifest with presigned URLs
   */
  private async downloadStoragesDirectly(
    sandbox: Sandbox,
    manifest: StorageManifest,
  ): Promise<void> {
    const totalArchives =
      manifest.storages.filter((s) => s.archiveUrl).length +
      (manifest.artifact?.archiveUrl ? 1 : 0);

    if (totalArchives === 0) {
      log.debug("No archives to download directly");
      return;
    }

    log.debug(
      `Downloading ${totalArchives} archives directly to sandbox using presigned URLs...`,
    );

    // Upload manifest to sandbox
    const manifestPath = "/tmp/storage-manifest.json";
    const manifestJson = JSON.stringify(manifest);
    const manifestBuffer = Buffer.from(manifestJson, "utf-8");
    const arrayBuffer = manifestBuffer.buffer.slice(
      manifestBuffer.byteOffset,
      manifestBuffer.byteOffset + manifestBuffer.byteLength,
    ) as ArrayBuffer;

    await sandbox.files.write(manifestPath, arrayBuffer);
    log.debug(`Uploaded storage manifest to ${manifestPath}`);

    // Execute download script (scripts already uploaded via uploadAllScripts)
    const downloadStart = Date.now();
    const result = await sandbox.commands.run(
      `python3 ${SCRIPT_PATHS.download} ${manifestPath}`,
      {
        timeoutMs: 300000, // 5 minute timeout for downloads
      },
    );

    const downloadTimeMs = Date.now() - downloadStart;

    if (result.exitCode !== 0) {
      log.error(`Storage download failed: ${result.stderr}`);
      throw new Error(`Storage download failed: ${result.stderr}`);
    }

    log.debug(
      `Downloaded ${totalArchives} archives directly to sandbox in ${downloadTimeMs}ms`,
    );
  }

  /**
   * Cleanup sandbox (used internally during preparation failures)
   */
  private async cleanupSandbox(sandbox: Sandbox): Promise<void> {
    try {
      log.debug(`Cleaning up sandbox ${sandbox.sandboxId}...`);
      await sandbox.kill();
      log.debug(`Sandbox ${sandbox.sandboxId} cleaned up`);
    } catch (error) {
      log.error(`Failed to cleanup sandbox ${sandbox.sandboxId}:`, error);
    }
  }

  /**
   * Kill a sandbox by its ID
   * Used by the complete API to cleanup sandboxes after run completion
   *
   * @param sandboxId The sandbox ID to kill
   */
  async killSandbox(sandboxId: string): Promise<void> {
    try {
      log.debug(`Killing sandbox ${sandboxId}...`);
      const sandbox = await Sandbox.connect(sandboxId);
      await sandbox.kill();
      log.debug(`Sandbox ${sandboxId} killed successfully`);
    } catch (error) {
      // Log but don't throw - sandbox may already be terminated
      log.error(`Failed to kill sandbox ${sandboxId}:`, error);
    }
  }
}

// Export singleton instance
export const e2bService = new E2BService();
