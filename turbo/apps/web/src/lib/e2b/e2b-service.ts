import { Sandbox } from "@e2b/code-interpreter";
import { e2bConfig } from "./config";
import { generateWebhookToken } from "../webhook-auth";
import type {
  CreateRuntimeOptions,
  RuntimeResult,
  SandboxExecutionResult,
} from "./types";

/**
 * E2B Service
 * Manages E2B sandbox creation and execution
 */
export class E2BService {
  /**
   * Create and execute an agent runtime
   * MVP: Executes simple "echo hello world" command
   * Future: Will execute Claude Code with real agent
   */
  async createRuntime(
    runtimeId: string,
    options: CreateRuntimeOptions,
  ): Promise<RuntimeResult> {
    const startTime = Date.now();

    console.log(
      `[E2B] Creating runtime ${runtimeId} for agent ${options.agentConfigId}...`,
    );

    let sandbox: Sandbox | null = null;

    try {
      // Generate webhook token
      const webhookToken = generateWebhookToken(runtimeId);

      // Get webhook configuration
      const webhookUrl =
        globalThis.services?.env?.VM0_API_URL || "http://localhost:3000";
      const webhookEndpoint = `${webhookUrl}/api/webhooks/agent-events`;

      console.log(`[E2B] Webhook endpoint: ${webhookEndpoint}`);
      console.log(`[E2B] Webhook token: ${webhookToken}`);

      // Create E2B sandbox
      sandbox = await this.createSandbox();
      console.log(`[E2B] Sandbox created: ${sandbox.sandboxId}`);

      // Execute Claude Code via run-agent.sh
      const result = await this.executeCommand(
        sandbox,
        runtimeId,
        options.prompt,
        webhookEndpoint,
        webhookToken,
      );

      const executionTimeMs = Date.now() - startTime;
      const completedAt = new Date();

      console.log(
        `[E2B] Runtime ${runtimeId} completed in ${executionTimeMs}ms`,
      );

      return {
        runtimeId,
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

      console.error(`[E2B] Runtime ${runtimeId} failed:`, error);

      return {
        runtimeId,
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
   * Create E2B sandbox with Claude Code
   */
  private async createSandbox(): Promise<Sandbox> {
    const sandboxOptions = {
      timeoutMs: e2bConfig.defaultTimeout,
    };

    // Use custom template if configured
    if (e2bConfig.defaultTemplate) {
      console.log(`[E2B] Using custom template: ${e2bConfig.defaultTemplate}`);
      // Template should be passed as first argument, not in options
      const sandbox = await Sandbox.create(
        e2bConfig.defaultTemplate,
        sandboxOptions,
      );
      return sandbox;
    } else {
      console.warn(
        "[E2B] No custom template configured. Ensure Claude Code CLI is available in the sandbox.",
      );
      const sandbox = await Sandbox.create(sandboxOptions);
      return sandbox;
    }
  }

  /**
   * Execute Claude Code via run-agent.sh script
   */
  private async executeCommand(
    sandbox: Sandbox,
    runtimeId: string,
    prompt: string,
    webhookUrl: string,
    webhookToken: string,
  ): Promise<SandboxExecutionResult> {
    const execStart = Date.now();

    // Upload run-agent.sh script to sandbox
    const scriptPath = "/opt/vm0/run-agent.sh";
    const scriptContent = await this.getRunAgentScript();

    console.log(`[E2B] Uploading run-agent.sh to ${scriptPath}...`);
    await sandbox.files.write(scriptPath, scriptContent);
    await sandbox.commands.run(`chmod +x ${scriptPath}`);

    console.log(`[E2B] Executing run-agent.sh for runtime ${runtimeId}...`);

    // Set environment variables and execute script
    const envs: Record<string, string> = {
      VM0_RUNTIME_ID: runtimeId,
      VM0_WEBHOOK_URL: webhookUrl,
      VM0_WEBHOOK_TOKEN: webhookToken,
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
      console.log(`[E2B] Runtime ${runtimeId} completed successfully`);
    } else {
      console.error(
        `[E2B] Runtime ${runtimeId} failed with exit code ${result.exitCode}`,
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
