import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../env";
import { e2bConfig } from "./config";
import type {
  CreateRunOptions,
  RunResult,
  SandboxExecutionResult,
} from "./types";
import { volumeService } from "../volume/volume-service";
import type { AgentVolumeConfig } from "../volume/types";
import type { AgentConfigYaml } from "../../types/agent-config";
import { RUN_AGENT_SCRIPT } from "./run-agent-script";

/**
 * E2B Service
 * Manages E2B sandbox creation and execution
 */
export class E2BService {
  /**
   * Create and execute an agent run
   * MVP: Executes simple "echo hello world" command
   * Future: Will execute Claude Code with real agent
   */
  async createRun(
    runId: string,
    options: CreateRunOptions,
  ): Promise<RunResult> {
    const startTime = Date.now();

    console.log(
      `[E2B] Creating run ${runId} for agent ${options.agentConfigId}...`,
    );

    let sandbox: Sandbox | null = null;
    const agentConfig = options.agentConfig as AgentVolumeConfig | undefined;

    // Prepare volumes (resolve + download) before try block
    const volumeResult = await volumeService.prepareVolumes(
      agentConfig,
      options.dynamicVars || {},
      runId,
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
        VM0_RUN_ID: runId,
        VM0_API_TOKEN: options.sandboxToken, // Temporary bearer token for webhook authentication
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

      // Execute Claude Code via run-agent.sh
      const result = await this.executeCommand(
        sandbox,
        runId,
        options.prompt,
        options.sandboxToken,
        options.agentConfig,
      );

      const executionTimeMs = Date.now() - startTime;
      const completedAt = new Date();

      console.log(`[E2B] Run ${runId} completed in ${executionTimeMs}ms`);

      return {
        runId,
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

      console.error(`[E2B] Run ${runId} failed:`, error);

      return {
        runId,
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

    if (result.exitCode === 0) {
      console.log(`[E2B] Run ${runId} completed successfully`);
    } else {
      console.error(
        `[E2B] Run ${runId} failed with exit code ${result.exitCode}`,
      );
      console.error(`[E2B] stderr:`, result.stderr);
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
