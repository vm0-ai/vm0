import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../env";
import { e2bConfig } from "./config";
import type { RunResult } from "./types";
import { storageService } from "../storage/storage-service";
import type {
  AgentVolumeConfig,
  PreparedArtifact,
  StorageManifest,
} from "../storage/types";
import type { AgentConfigYaml } from "../../types/agent-config";
import {
  COMMON_SCRIPT,
  LOG_SCRIPT,
  REQUEST_SCRIPT,
  SEND_EVENT_SCRIPT,
  VAS_SNAPSHOT_SCRIPT,
  CREATE_CHECKPOINT_SCRIPT,
  RUN_AGENT_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  DOWNLOAD_STORAGES_SCRIPT,
  INCREMENTAL_UPLOAD_SCRIPT,
  SCRIPT_PATHS,
} from "./scripts";
import type { ExecutionContext } from "../run/types";
import { calculateSessionHistoryPath } from "../run/run-service";
import { sendVm0ErrorEvent, sendVm0StartEvent } from "../events";
import { logger } from "../logger";

const log = logger("service:e2b");

/**
 * Get the first agent from config (currently only one agent is supported)
 */
function getFirstAgent(
  config?: AgentConfigYaml,
): AgentConfigYaml["agents"][string] | undefined {
  if (!config?.agents) return undefined;
  const values = Object.values(config.agents);
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
      `${isResume ? "Resuming" : "Creating"} run ${context.runId} for agent ${context.agentConfigId}...`,
    );
    log.debug(
      `context.volumeVersions=${JSON.stringify(context.volumeVersions)}`,
    );

    let sandbox: Sandbox | null = null;
    const agentConfig = context.agentConfig as AgentVolumeConfig | undefined;
    const agentConfigYaml = context.agentConfig as AgentConfigYaml | undefined;

    // Get mount path from agent config (used for resume artifact)
    const firstAgent = getFirstAgent(agentConfigYaml);
    const artifactMountPath = firstAgent?.working_dir || "/workspace";

    try {
      // Prepare storage manifest with presigned URLs for direct download to sandbox
      // This works for both new runs and resume scenarios
      const storageManifest = await storageService.prepareStorageManifest(
        agentConfig,
        context.templateVars || {},
        context.userId || "",
        context.artifactName,
        context.artifactVersion,
        context.volumeVersions,
        context.resumeArtifact, // For resume: use artifact from checkpoint snapshot
        artifactMountPath,
      );

      // Build artifact and volumes info from manifest for vm0_start event
      const startArtifact = storageManifest.artifact
        ? {
            [storageManifest.artifact.vasStorageName]:
              storageManifest.artifact.vasVersionId,
          }
        : undefined;

      const startVolumes =
        storageManifest.storages.length > 0
          ? storageManifest.storages.reduce(
              (acc, vol) => {
                acc[vol.name] = vol.vasVersionId;
                return acc;
              },
              {} as Record<string, string>,
            )
          : undefined;

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

      // Send vm0_start event now that storages are prepared
      await sendVm0StartEvent({
        runId: context.runId,
        agentConfigId: context.agentConfigId,
        agentName: context.agentName,
        prompt: context.prompt,
        templateVars: context.templateVars,
        resumedFromCheckpointId: context.resumedFromCheckpointId,
        continuedFromSessionId: context.continuedFromSessionId,
        artifact: startArtifact,
        volumes: startVolumes,
      });

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

      sandbox = await this.createSandbox(
        sandboxEnvVars,
        agentConfig as AgentConfigYaml | undefined,
      );
      log.debug(`Sandbox created: ${sandbox.sandboxId}`);

      // Download storages directly to sandbox via presigned URLs
      await this.downloadStoragesDirectly(sandbox, storageManifest);

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
      await this.startAgentExecution(
        sandbox,
        context.runId,
        context.prompt,
        context.sandboxToken,
        context.agentConfig,
        artifactForCommand,
        context.resumeSession?.sessionId,
      );

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

      // Send vm0_error event so CLI doesn't timeout
      try {
        await sendVm0ErrorEvent({
          runId: context.runId,
          error: errorMessage,
        });
      } catch (e) {
        log.error(
          `Failed to send vm0_error event for run ${context.runId}:`,
          e,
        );
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
    // Sandbox will auto-terminate after timeout (1 hour) or when run-agent.sh completes
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
   * @param agentConfig Agent configuration containing image specification
   */
  private async createSandbox(
    envVars: Record<string, string>,
    agentConfig?: AgentConfigYaml,
  ): Promise<Sandbox> {
    const sandboxOptions = {
      timeoutMs: 3_600_000, // 1 hour timeout to allow for long-running operations
      envs: envVars, // Pass environment variables to sandbox
    };

    // Priority: agent.image > E2B_TEMPLATE_NAME
    const agent = getFirstAgent(agentConfig);
    const templateName = agent?.image || e2bConfig.defaultTemplate;

    if (!templateName) {
      throw new Error(
        "[E2B] No template specified. Either set agent.image in vm0.config.yaml or E2B_TEMPLATE_NAME environment variable.",
      );
    }

    log.debug(`Using template: ${templateName}`);
    log.debug(
      `Template source: ${agent?.image ? "agent.image" : "E2B_TEMPLATE_NAME"}`,
    );
    log.debug(`Sandbox env vars:`, Object.keys(envVars));

    const sandbox = await Sandbox.create(templateName, sandboxOptions);
    return sandbox;
  }

  /**
   * Upload all agent scripts to sandbox
   * Scripts are split into single-responsibility modules for better maintainability
   */
  private async uploadRunAgentScript(sandbox: Sandbox): Promise<string> {
    // Create directory structure
    await sandbox.commands.run(
      `sudo mkdir -p ${SCRIPT_PATHS.baseDir} ${SCRIPT_PATHS.libDir}`,
    );

    // Define scripts to upload
    // Note: DOWNLOAD_STORAGES_SCRIPT is uploaded separately in uploadDownloadScript()
    // before storage download, so we don't include it here to avoid duplicate upload
    const scripts: Array<{ content: string; path: string }> = [
      { content: COMMON_SCRIPT, path: SCRIPT_PATHS.common },
      { content: LOG_SCRIPT, path: SCRIPT_PATHS.log },
      { content: REQUEST_SCRIPT, path: SCRIPT_PATHS.request },
      { content: SEND_EVENT_SCRIPT, path: SCRIPT_PATHS.sendEvent },
      { content: VAS_SNAPSHOT_SCRIPT, path: SCRIPT_PATHS.vasSnapshot },
      {
        content: CREATE_CHECKPOINT_SCRIPT,
        path: SCRIPT_PATHS.createCheckpoint,
      },
      { content: RUN_AGENT_SCRIPT, path: SCRIPT_PATHS.runAgent },
      { content: MOCK_CLAUDE_SCRIPT, path: SCRIPT_PATHS.mockClaude },
      {
        content: INCREMENTAL_UPLOAD_SCRIPT,
        path: SCRIPT_PATHS.incrementalUpload,
      },
    ];

    // Upload all scripts in parallel for better performance
    await Promise.all(
      scripts.map(async (script) => {
        const tempPath = `/tmp/${script.path.split("/").pop()}`;

        // Convert script string to ArrayBuffer for E2B
        const scriptBuffer = Buffer.from(script.content, "utf-8");
        const arrayBuffer = scriptBuffer.buffer.slice(
          scriptBuffer.byteOffset,
          scriptBuffer.byteOffset + scriptBuffer.byteLength,
        ) as ArrayBuffer;

        // Upload to temp location first
        await sandbox.files.write(tempPath, arrayBuffer);

        // Move to final location and make executable
        await sandbox.commands.run(
          `sudo mv ${tempPath} ${script.path} && sudo chmod +x ${script.path}`,
        );
      }),
    );

    log.debug(
      `Uploaded ${scripts.length} agent scripts to sandbox: ${SCRIPT_PATHS.baseDir}`,
    );
    return SCRIPT_PATHS.runAgent;
  }

  /**
   * Start agent execution (fire-and-forget)
   * Uploads scripts and starts run-agent.sh in background without waiting
   */
  private async startAgentExecution(
    sandbox: Sandbox,
    runId: string,
    prompt: string,
    sandboxToken: string,
    agentConfig?: unknown,
    preparedArtifact?: PreparedArtifact | null,
    resumeSessionId?: string,
  ): Promise<void> {
    // Upload run-agent.sh script to sandbox at runtime
    // This allows script changes without rebuilding the E2B template
    const scriptPath = await this.uploadRunAgentScript(sandbox);

    log.debug(`Starting run-agent.sh for run ${runId} (fire-and-forget)...`);

    // Extract working_dir from agent config
    const config = agentConfig as AgentConfigYaml | undefined;
    const workingDir = getFirstAgent(config)?.working_dir;

    // Set environment variables
    const envs: Record<string, string> = {
      VM0_RUN_ID: runId,
      VM0_API_TOKEN: sandboxToken,
      VM0_PROMPT: prompt,
    };

    // Add working directory if configured
    if (workingDir) {
      envs.VM0_WORKING_DIR = workingDir;
      log.debug(`Working directory configured: ${workingDir}`);
    }

    // Add resume session ID if provided
    if (resumeSessionId) {
      envs.VM0_RESUME_SESSION_ID = resumeSessionId;
      log.debug(`Resume session ID configured: ${resumeSessionId}`);
    }

    // Pass USE_MOCK_CLAUDE for testing (executes prompt as bash instead of calling LLM)
    if (process.env.USE_MOCK_CLAUDE === "true") {
      envs.USE_MOCK_CLAUDE = "true";
      log.debug(`Using mock-claude for testing`);
    }

    // Add artifact information for checkpoint
    // Only artifact creates new versions after agent runs
    if (preparedArtifact) {
      log.debug(`Prepared artifact for checkpoint:`, {
        driver: preparedArtifact.driver,
        mountPath: preparedArtifact.mountPath,
        vasStorageName: preparedArtifact.vasStorageName,
      });

      // VAS artifact - pass info for vas snapshot
      envs.VM0_ARTIFACT_DRIVER = "vas";
      envs.VM0_ARTIFACT_MOUNT_PATH = preparedArtifact.mountPath;
      envs.VM0_ARTIFACT_VOLUME_NAME = preparedArtifact.vasStorageName;
      envs.VM0_ARTIFACT_VERSION_ID = preparedArtifact.vasVersionId;

      // Pass manifest URL for incremental upload
      if (preparedArtifact.manifestUrl) {
        envs.VM0_ARTIFACT_MANIFEST_URL = preparedArtifact.manifestUrl;
        log.debug(`Configured manifest URL for incremental upload`);
      }

      log.debug(`Configured VAS artifact for checkpoint`);
    } else {
      log.debug(`No artifact configured for checkpoint`);
    }

    // Add Minimax API configuration if available
    const minimaxBaseUrl = env().MINIMAX_ANTHROPIC_BASE_URL;
    const minimaxApiKey = env().MINIMAX_API_KEY;

    if (minimaxBaseUrl && minimaxApiKey) {
      envs.ANTHROPIC_BASE_URL = minimaxBaseUrl;
      envs.ANTHROPIC_AUTH_TOKEN = minimaxApiKey;
      envs.API_TIMEOUT_MS = "3000000";
      envs.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
      envs.ANTHROPIC_MODEL = "MiniMax-M2";
      envs.ANTHROPIC_SMALL_FAST_MODEL = "MiniMax-M2";
      envs.ANTHROPIC_DEFAULT_SONNET_MODEL = "MiniMax-M2";
      envs.ANTHROPIC_DEFAULT_OPUS_MODEL = "MiniMax-M2";
      envs.ANTHROPIC_DEFAULT_HAIKU_MODEL = "MiniMax-M2";
      log.debug(`Using Minimax API (${minimaxBaseUrl})`);
    }

    // Start script in background using E2B's native background mode
    // This returns immediately while the command continues executing in the sandbox
    await sandbox.commands.run(scriptPath, {
      envs,
      background: true,
    });

    log.debug(`Agent execution started in background for run ${runId}`);
  }

  /**
   * Download storages directly to sandbox using presigned URLs
   * This method uploads a manifest file and runs a download script inside the sandbox
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

    // Upload download script first (needed before executeCommand uploads all scripts)
    await this.uploadDownloadScript(sandbox);

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

    // Execute download script
    const downloadStart = Date.now();
    const result = await sandbox.commands.run(
      `${SCRIPT_PATHS.downloadStorages} ${manifestPath}`,
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
   * Upload download-storages.sh and its dependencies (common.sh, log.sh)
   * Used before all scripts are uploaded by executeCommand
   */
  private async uploadDownloadScript(sandbox: Sandbox): Promise<void> {
    // Create directory structure
    await sandbox.commands.run(
      `sudo mkdir -p ${SCRIPT_PATHS.baseDir} ${SCRIPT_PATHS.libDir}`,
    );

    // Upload download script and its dependencies in parallel
    const scripts = [
      { content: COMMON_SCRIPT, path: SCRIPT_PATHS.common },
      { content: LOG_SCRIPT, path: SCRIPT_PATHS.log },
      {
        content: DOWNLOAD_STORAGES_SCRIPT,
        path: SCRIPT_PATHS.downloadStorages,
      },
    ];

    await Promise.all(
      scripts.map(async (script) => {
        const tempPath = `/tmp/${script.path.split("/").pop()}`;
        const scriptBuffer = Buffer.from(script.content, "utf-8");
        const arrayBuffer = scriptBuffer.buffer.slice(
          scriptBuffer.byteOffset,
          scriptBuffer.byteOffset + scriptBuffer.byteLength,
        ) as ArrayBuffer;

        await sandbox.files.write(tempPath, arrayBuffer);
        await sandbox.commands.run(
          `sudo mv ${tempPath} ${script.path} && sudo chmod +x ${script.path}`,
        );
      }),
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
