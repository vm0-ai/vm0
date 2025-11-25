import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../env";
import { e2bConfig } from "./config";
import type { RunResult, SandboxExecutionResult } from "./types";
import { volumeService } from "../volume/volume-service";
import type { AgentVolumeConfig, PreparedVolume } from "../volume/types";
import type { AgentConfigYaml } from "../../types/agent-config";
import { RUN_AGENT_SCRIPT } from "./run-agent-script";
import type { ExecutionContext } from "../run/types";
import { calculateSessionHistoryPath } from "../run/run-service";

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

    // Prepare volumes - use snapshots for resume, or fresh volumes for new run
    const volumeResult = context.resumeVolumes
      ? await volumeService.prepareVolumesFromSnapshots(
          context.resumeVolumes,
          agentConfig,
          context.dynamicVars || {},
        )
      : await volumeService.prepareVolumes(
          agentConfig,
          context.dynamicVars || {},
          context.runId,
          context.userId,
        );

    try {
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

      // Mount volumes to sandbox
      await volumeService.mountVolumes(sandbox, volumeResult.preparedVolumes);

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
        volumeResult.preparedVolumes,
        context.resumeSession?.sessionId,
      );

      const executionTimeMs = Date.now() - startTime;
      const completedAt = new Date();

      console.log(
        `[E2B] Run ${context.runId} completed in ${executionTimeMs}ms`,
      );

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

      console.error(`[E2B] Run ${context.runId} failed:`, error);

      return {
        runId: context.runId,
        sandboxId: sandbox?.sandboxId || "unknown",
        status: "failed",
        output: "",
        error: error instanceof Error ? error.message : "Unknown error",
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
      await volumeService.cleanup(volumeResult.tempDir);
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

    // Priority: agent.image > E2B_TEMPLATE_NAME
    const templateName = agentConfig?.agent?.image || e2bConfig.defaultTemplate;

    if (!templateName) {
      throw new Error(
        "[E2B] No template specified. Either set agent.image in vm0.config.yaml or E2B_TEMPLATE_NAME environment variable.",
      );
    }

    console.log(`[E2B] Using template: ${templateName}`);
    console.log(
      `[E2B] Template source: ${agentConfig?.agent?.image ? "agent.image" : "E2B_TEMPLATE_NAME"}`,
    );
    console.log(`[E2B] Sandbox env vars:`, Object.keys(envVars));

    const sandbox = await Sandbox.create(templateName, sandboxOptions);
    return sandbox;
  }

  /**
   * Upload run-agent.sh script to sandbox
   * The script content is embedded in the application code for reliable deployment
   * Updated: Using jq for JSON generation in git snapshots
   */
  private async uploadRunAgentScript(sandbox: Sandbox): Promise<string> {
    const tempPath = "/tmp/run-agent.sh";
    const finalPath = "/usr/local/bin/run-agent.sh";

    try {
      // Convert script string to ArrayBuffer for E2B
      const scriptBuffer = Buffer.from(RUN_AGENT_SCRIPT, "utf-8");
      const arrayBuffer = scriptBuffer.buffer.slice(
        scriptBuffer.byteOffset,
        scriptBuffer.byteOffset + scriptBuffer.byteLength,
      ) as ArrayBuffer;

      // Upload to temp location first
      await sandbox.files.write(tempPath, arrayBuffer);

      // Move to /usr/local/bin/ and make executable
      await sandbox.commands.run(
        `sudo mv ${tempPath} ${finalPath} && sudo chmod +x ${finalPath}`,
      );

      console.log(`[E2B] Uploaded run-agent.sh to sandbox: ${finalPath}`);
      return finalPath;
    } catch (error) {
      console.error(`[E2B] Failed to upload run-agent.sh:`, error);
      throw new Error(
        `Failed to upload run-agent.sh script: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
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
    preparedVolumes?: PreparedVolume[],
    resumeSessionId?: string,
  ): Promise<SandboxExecutionResult> {
    const execStart = Date.now();

    // Upload run-agent.sh script to sandbox at runtime
    // This allows script changes without rebuilding the E2B template
    const scriptPath = await this.uploadRunAgentScript(sandbox);

    console.log(`[E2B] Executing run-agent.sh for run ${runId}...`);

    // Extract working_dir from agent config
    const config = agentConfig as AgentConfigYaml | undefined;
    const workingDir = config?.agent?.working_dir;

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

    // Add volume information for checkpoint
    if (preparedVolumes && preparedVolumes.length > 0) {
      // Filter only Git volumes and format for checkpoint
      const gitVolumes = preparedVolumes
        .filter((v) => v.driver === "git")
        .map((v) => ({
          name: v.name,
          driver: v.driver,
          mountPath: v.mountPath,
        }));

      if (gitVolumes.length > 0) {
        envs.VM0_GIT_VOLUMES = JSON.stringify(gitVolumes);
        console.log(
          `[E2B] Configured ${gitVolumes.length} Git volume(s) for checkpoint`,
        );
      }
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
