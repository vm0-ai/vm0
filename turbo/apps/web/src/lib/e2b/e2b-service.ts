import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../env";
import { e2bConfig } from "./config";
import type { RunResult, SandboxExecutionResult } from "./types";
import { storageService } from "../storage/storage-service";
import type {
  AgentVolumeConfig,
  PreparedStorage,
  PreparedArtifact,
} from "../storage/types";
import type { AgentConfigYaml } from "../../types/agent-config";
import {
  COMMON_SCRIPT,
  SEND_EVENT_SCRIPT,
  VAS_SNAPSHOT_SCRIPT,
  CREATE_CHECKPOINT_SCRIPT,
  RUN_AGENT_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  SCRIPT_PATHS,
} from "./scripts";
import type { ExecutionContext } from "../run/types";
import { calculateSessionHistoryPath } from "../run/run-service";
import { sendVm0ErrorEvent } from "../events";

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

    console.log(
      `[E2B] ${isResume ? "Resuming" : "Creating"} run ${context.runId} for agent ${context.agentConfigId}...`,
    );

    let sandbox: Sandbox | null = null;
    const agentConfig = context.agentConfig as AgentVolumeConfig | undefined;

    // Prepare storages and artifact
    // For resume: use artifact from snapshot
    // For new run: prepare fresh storages and artifact
    let storageResult: {
      preparedStorages: PreparedStorage[];
      preparedArtifact: PreparedArtifact | null;
      tempDir: string | null;
      errors: string[];
    };

    if (context.resumeArtifact) {
      // Resume from artifact snapshot
      const artifactResult = await storageService.prepareArtifactFromSnapshot(
        context.resumeArtifact,
        context.runId,
      );

      // Also prepare regular storages (fresh, not from snapshot)
      // Skip artifact validation since we're using the snapshot
      const freshStorages = await storageService.prepareStorages(
        agentConfig,
        context.dynamicVars || {},
        context.runId,
        context.userId || "",
        undefined, // No artifact name for resume
        undefined, // No artifact version for resume
        true, // Skip artifact validation - using snapshot instead
      );

      storageResult = {
        preparedStorages: freshStorages.preparedStorages,
        preparedArtifact: artifactResult.preparedArtifact,
        tempDir: artifactResult.tempDir || freshStorages.tempDir,
        errors: [...freshStorages.errors, ...artifactResult.errors],
      };
    } else {
      // New run - prepare storages and artifact
      storageResult = await storageService.prepareStorages(
        agentConfig,
        context.dynamicVars || {},
        context.runId,
        context.userId || "",
        context.artifactName,
        context.artifactVersion,
      );
    }

    try {
      // Fail fast if any storages failed to prepare
      if (storageResult.errors.length > 0) {
        throw new Error(
          `Storage preparation failed: ${storageResult.errors.join("; ")}`,
        );
      }
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

      console.log(
        `[E2B] Environment - VERCEL_ENV: ${vercelEnv}, VERCEL_URL: ${vercelUrl}, VM0_API_URL: ${apiUrl}`,
      );
      console.log(`[E2B] Computed API URL: ${apiUrl}`);
      console.log(`[E2B] Webhook: ${webhookEndpoint}`);

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
        console.log(
          `[E2B] Added Vercel protection bypass for preview deployment`,
        );
      }

      sandbox = await this.createSandbox(
        sandboxEnvVars,
        agentConfig as AgentConfigYaml | undefined,
      );
      console.log(`[E2B] Sandbox created: ${sandbox.sandboxId}`);

      // Mount storages and artifact to sandbox
      await storageService.mountStorages(
        sandbox,
        storageResult.preparedStorages,
        storageResult.preparedArtifact,
      );

      // Restore session history for resume
      if (context.resumeSession) {
        await this.restoreSessionHistory(
          sandbox,
          context.resumeSession.sessionId,
          context.resumeSession.sessionHistory,
          context.resumeSession.workingDir,
        );
      }

      // Execute Claude Code via run-agent.sh
      const result = await this.executeCommand(
        sandbox,
        context.runId,
        context.prompt,
        context.sandboxToken,
        context.agentConfig,
        storageResult.preparedArtifact,
        context.resumeSession?.sessionId,
      );

      const executionTimeMs = Date.now() - startTime;
      const completedAt = new Date();

      console.log(
        `[E2B] Run ${context.runId} completed in ${executionTimeMs}ms`,
      );

      // If sandbox script failed, send vm0_error event
      // This ensures CLI doesn't timeout waiting for events
      if (result.exitCode !== 0) {
        try {
          await sendVm0ErrorEvent({
            runId: context.runId,
            error: result.stderr || "Agent execution failed",
          });
        } catch (e) {
          console.error(
            `[E2B] Failed to send vm0_error event for run ${context.runId}:`,
            e,
          );
        }
      }

      return {
        runId: context.runId,
        sandboxId: sandbox.sandboxId,
        status: result.exitCode === 0 ? "completed" : "failed",
        output: result.stdout,
        error: result.exitCode !== 0 ? result.stderr : undefined,
        executionTimeMs,
        createdAt: new Date(startTime),
        completedAt,
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const completedAt = new Date();
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      console.error(`[E2B] Run ${context.runId} failed:`, error);

      // Send vm0_error event so CLI doesn't timeout
      try {
        await sendVm0ErrorEvent({
          runId: context.runId,
          error: errorMessage,
        });
      } catch (e) {
        console.error(
          `[E2B] Failed to send vm0_error event for run ${context.runId}:`,
          e,
        );
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
    } finally {
      // Always cleanup sandbox
      if (sandbox) {
        await this.cleanupSandbox(sandbox);
      }

      // Cleanup temp directory
      await storageService.cleanup(storageResult.tempDir);
    }
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
    console.log(`[E2B] Restoring session history for ${sessionId}...`);

    // Calculate session history path using same logic as run-agent-script
    const sessionHistoryPath = calculateSessionHistoryPath(
      workingDir,
      sessionId,
    );

    console.log(`[E2B] Session history path: ${sessionHistoryPath}`);

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

    console.log(
      `[E2B] Session history restored (${sessionHistory.split("\n").length} lines)`,
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

    // Priority: agents[0].image > E2B_TEMPLATE_NAME
    const templateName =
      agentConfig?.agents?.[0]?.image || e2bConfig.defaultTemplate;

    if (!templateName) {
      throw new Error(
        "[E2B] No template specified. Either set agents[0].image in vm0.config.yaml or E2B_TEMPLATE_NAME environment variable.",
      );
    }

    console.log(`[E2B] Using template: ${templateName}`);
    console.log(
      `[E2B] Template source: ${agentConfig?.agents?.[0]?.image ? "agents[0].image" : "E2B_TEMPLATE_NAME"}`,
    );
    console.log(`[E2B] Sandbox env vars:`, Object.keys(envVars));

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
    const scripts: Array<{ content: string; path: string }> = [
      { content: COMMON_SCRIPT, path: SCRIPT_PATHS.common },
      { content: SEND_EVENT_SCRIPT, path: SCRIPT_PATHS.sendEvent },
      { content: VAS_SNAPSHOT_SCRIPT, path: SCRIPT_PATHS.vasSnapshot },
      {
        content: CREATE_CHECKPOINT_SCRIPT,
        path: SCRIPT_PATHS.createCheckpoint,
      },
      { content: RUN_AGENT_SCRIPT, path: SCRIPT_PATHS.runAgent },
      { content: MOCK_CLAUDE_SCRIPT, path: SCRIPT_PATHS.mockClaude },
    ];

    // Upload each script
    for (const script of scripts) {
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
    }

    console.log(
      `[E2B] Uploaded ${scripts.length} agent scripts to sandbox: ${SCRIPT_PATHS.baseDir}`,
    );
    return SCRIPT_PATHS.runAgent;
  }

  /**
   * Execute Claude Code via run-agent.sh script
   */
  private async executeCommand(
    sandbox: Sandbox,
    runId: string,
    prompt: string,
    sandboxToken: string,
    agentConfig?: unknown,
    preparedArtifact?: PreparedArtifact | null,
    resumeSessionId?: string,
  ): Promise<SandboxExecutionResult> {
    const execStart = Date.now();

    // Upload run-agent.sh script to sandbox at runtime
    // This allows script changes without rebuilding the E2B template
    const scriptPath = await this.uploadRunAgentScript(sandbox);

    console.log(`[E2B] Executing run-agent.sh for run ${runId}...`);

    // Extract working_dir from agent config
    const config = agentConfig as AgentConfigYaml | undefined;
    const workingDir = config?.agents?.[0]?.working_dir;

    // Set environment variables and execute script
    const envs: Record<string, string> = {
      VM0_RUN_ID: runId,
      VM0_API_TOKEN: sandboxToken,
      VM0_PROMPT: prompt,
    };

    // Add working directory if configured
    if (workingDir) {
      envs.VM0_WORKING_DIR = workingDir;
      console.log(`[E2B] Working directory configured: ${workingDir}`);
    }

    // Add resume session ID if provided
    if (resumeSessionId) {
      envs.VM0_RESUME_SESSION_ID = resumeSessionId;
      console.log(`[E2B] Resume session ID configured: ${resumeSessionId}`);
    }

    // Pass USE_MOCK_CLAUDE for testing (executes prompt as bash instead of calling LLM)
    if (process.env.USE_MOCK_CLAUDE === "true") {
      envs.USE_MOCK_CLAUDE = "true";
      console.log(`[E2B] Using mock-claude for testing`);
    }

    // Add artifact information for checkpoint
    // Only artifact creates new versions after agent runs
    if (preparedArtifact) {
      console.log(
        `[E2B] Prepared artifact for checkpoint:`,
        JSON.stringify({
          driver: preparedArtifact.driver,
          mountPath: preparedArtifact.mountPath,
          vasStorageName: preparedArtifact.vasStorageName,
        }),
      );

      // VAS artifact - pass info for vas snapshot
      envs.VM0_ARTIFACT_DRIVER = "vas";
      envs.VM0_ARTIFACT_MOUNT_PATH = preparedArtifact.mountPath;
      envs.VM0_ARTIFACT_VOLUME_NAME = preparedArtifact.vasStorageName;
      envs.VM0_ARTIFACT_VERSION_ID = preparedArtifact.vasVersionId;
      console.log(`[E2B] Configured VAS artifact for checkpoint`);
    } else {
      console.log(`[E2B] No artifact configured for checkpoint`);
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
      console.log(`[E2B] Using Minimax API (${minimaxBaseUrl})`);
    }

    const result = await sandbox.commands.run(scriptPath, {
      envs,
      timeoutMs: 0, // No timeout - allows indefinite execution
    });

    const executionTimeMs = Date.now() - execStart;

    // Always log stderr to capture [VM0] checkpoint logs (even on success)
    console.log(`[E2B] stderr (${result.stderr.length} chars):`, result.stderr);

    if (result.exitCode === 0) {
      console.log(`[E2B] Run ${runId} completed successfully`);
    } else {
      console.error(
        `[E2B] Run ${runId} failed with exit code ${result.exitCode}`,
      );
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      executionTimeMs,
    };
  }

  /**
   * Cleanup sandbox
   */
  private async cleanupSandbox(sandbox: Sandbox): Promise<void> {
    try {
      console.log(`[E2B] Cleaning up sandbox ${sandbox.sandboxId}...`);
      await sandbox.kill();
      console.log(`[E2B] Sandbox ${sandbox.sandboxId} cleaned up`);
    } catch (error) {
      console.error(
        `[E2B] Failed to cleanup sandbox ${sandbox.sandboxId}:`,
        error,
      );
    }
  }
}

// Export singleton instance
export const e2bService = new E2BService();
