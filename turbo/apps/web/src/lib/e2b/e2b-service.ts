import { Sandbox } from "@e2b/code-interpreter";
import { e2bConfig } from "./config";
import type {
  CreateRunOptions,
  RunResult,
  SandboxExecutionResult,
} from "./types";

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

    try {
      // Get API configuration
      const apiUrl =
        globalThis.services?.env?.VM0_API_URL || "http://localhost:3000";
      const webhookEndpoint = `${apiUrl}/api/webhooks/agent-events`;

      console.log(`[E2B] API URL: ${apiUrl}`);
      console.log(`[E2B] Webhook endpoint: ${webhookEndpoint}`);
      console.log(`[E2B] Run ID: ${runId}`);

      // Create E2B sandbox with environment variables
      sandbox = await this.createSandbox({
        VM0_API_URL: apiUrl,
        VM0_WEBHOOK_URL: webhookEndpoint,
        VM0_RUN_ID: runId,
        VM0_TOKEN: options.sandboxToken, // Temporary bearer token for API calls
      });
      console.log(`[E2B] Sandbox created: ${sandbox.sandboxId}`);

      // Execute Claude Code via run-agent.sh
      const result = await this.executeCommand(
        sandbox,
        runId,
        options.prompt,
        webhookEndpoint,
        options.sandboxToken,
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
    }
  }

  /**
   * Create E2B sandbox with Claude Code and environment variables
   */
  private async createSandbox(
    envVars: Record<string, string>,
  ): Promise<Sandbox> {
    const sandboxOptions = {
      timeoutMs: e2bConfig.defaultTimeout,
      envs: envVars, // Pass environment variables to sandbox
    };

    // Use custom template if configured (by name/alias)
    if (e2bConfig.defaultTemplate) {
      console.log(`[E2B] Using custom template: ${e2bConfig.defaultTemplate}`);
      console.log(`[E2B] Sandbox env vars:`, Object.keys(envVars));
      // Template name/alias should be passed as first argument
      const sandbox = await Sandbox.create(
        e2bConfig.defaultTemplate,
        sandboxOptions,
      );
      return sandbox;
    } else {
      console.warn(
        "[E2B] No custom template configured. Ensure Claude Code CLI is available in the sandbox.",
      );
      console.log(`[E2B] Sandbox env vars:`, Object.keys(envVars));
      const sandbox = await Sandbox.create(sandboxOptions);
      return sandbox;
    }
  }

  /**
   * Execute Claude Code via run-agent.sh script
   */
  private async executeCommand(
    sandbox: Sandbox,
    runId: string,
    prompt: string,
    webhookUrl: string,
    sandboxToken: string,
  ): Promise<SandboxExecutionResult> {
    const execStart = Date.now();

    // Upload run-agent.sh script to sandbox
    const scriptPath = "/opt/vm0/run-agent.sh";
    const scriptContent = await this.getRunAgentScript();

    console.log(`[E2B] Uploading run-agent.sh to ${scriptPath}...`);
    await sandbox.files.write(scriptPath, scriptContent);
    await sandbox.commands.run(`chmod +x ${scriptPath}`);

    console.log(`[E2B] Executing run-agent.sh for run ${runId}...`);

    // Set environment variables and execute script
    const envs: Record<string, string> = {
      VM0_RUN_ID: runId,
      VM0_WEBHOOK_URL: webhookUrl,
      VM0_TOKEN: sandboxToken,
      VM0_PROMPT: prompt,
    };

    // Add Minimax API configuration if available
    const minimaxBaseUrl = process.env.MINIMAX_ANTHROPIC_BASE_URL;
    const minimaxApiKey = process.env.MINIMAX_API_KEY;

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
   * Load run-agent.sh script content
   */
  private async getRunAgentScript(): Promise<string> {
    const fs = await import("fs/promises");
    const path = await import("path");

    const scriptPath = path.join(__dirname, "scripts", "run-agent.sh");
    return fs.readFile(scriptPath, "utf-8");
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
