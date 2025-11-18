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

      // TODO: When implementing run-agent.sh (Issue #53), pass these as environment variables:
      // VM0_WEBHOOK_URL: webhookEndpoint
      // VM0_WEBHOOK_TOKEN: webhookToken
      // VM0_RUNTIME_ID: runtimeId

      // Create E2B sandbox
      sandbox = await this.createSandbox();
      console.log(`[E2B] Sandbox created: ${sandbox.sandboxId}`);

      // Execute command (MVP: simple echo, Future: Claude Code)
      const result = await this.executeCommand(sandbox);

      const executionTimeMs = Date.now() - startTime;
      const completedAt = new Date();

      console.log(
        `[E2B] Runtime ${runtimeId} completed in ${executionTimeMs}ms`,
      );

      return {
        runtimeId,
        sandboxId: sandbox.sandboxId,
        status: "completed",
        output: result.stdout,
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
   * Create E2B sandbox
   */
  private async createSandbox(): Promise<Sandbox> {
    const sandbox = await Sandbox.create({
      timeoutMs: e2bConfig.defaultTimeout,
      // Future: Add template/image configuration
      // template: e2bConfig.defaultImage,
    });

    return sandbox;
  }

  /**
   * Execute command in sandbox
   * MVP: Simple echo command
   * Future: Run Claude Code with agent configuration
   */
  private async executeCommand(
    sandbox: Sandbox,
  ): Promise<SandboxExecutionResult> {
    const execStart = Date.now();

    // MVP: Simple hello world command
    // Future: Replace with Claude Code execution
    const command = `echo 'Hello World from E2B!'`;

    console.log(`[E2B] Executing command: ${command}`);

    const result = await sandbox.commands.run(command);

    const executionTimeMs = Date.now() - execStart;

    console.log(`[E2B] Command output: ${result.stdout.trim()}`);

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
