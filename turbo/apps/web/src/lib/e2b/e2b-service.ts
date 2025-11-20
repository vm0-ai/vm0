import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../env";
import { e2bConfig } from "./config";
import type {
  CreateRunOptions,
  RunResult,
  SandboxExecutionResult,
} from "./types";
import { resolveVolumes } from "../volume/volume-resolver";
import { downloadS3Directory } from "../s3/s3-client";
import type { AgentVolumeConfig } from "../volume/types";
import type { AgentConfigYaml } from "../../types/agent-config";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * E2B Service
 * Manages E2B sandbox creation and execution
 */
export class E2BService {
  /**
   * Upload directory contents to E2B sandbox recursively
   */
  private async uploadDirectoryToSandbox(
    sandbox: Sandbox,
    localDir: string,
    remotePath: string,
  ): Promise<void> {
    const entries = await fs.promises.readdir(localDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name);
      const remoteFilePath = path.posix.join(remotePath, entry.name);

      if (entry.isDirectory()) {
        await this.uploadDirectoryToSandbox(sandbox, localPath, remoteFilePath);
      } else {
        const content = await fs.promises.readFile(localPath);
        // Convert Buffer to ArrayBuffer for E2B
        const arrayBuffer = content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength,
        ) as ArrayBuffer;
        await sandbox.files.write(remoteFilePath, arrayBuffer);
      }
    }
  }

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
    let tempDir: string | null = null;

    try {
      // Get API configuration
      const apiUrl =
        globalThis.services?.env?.VM0_API_URL || "http://localhost:3000";
      const webhookEndpoint = `${apiUrl}/api/webhooks/agent-events`;

      console.log(`[E2B] API URL: ${apiUrl}`);
      console.log(`[E2B] Webhook endpoint: ${webhookEndpoint}`);
      console.log(`[E2B] Run ID: ${runId}`);

      // Resolve volumes from agent config
      const agentConfig = options.agentConfig as AgentVolumeConfig | undefined;
      const volumeResult = agentConfig
        ? resolveVolumes(agentConfig, options.dynamicVars || {})
        : { volumes: [], errors: [] };

      // Log volume resolution errors but don't fail the run
      if (volumeResult.errors.length > 0) {
        console.warn(`[E2B] Volume resolution errors:`, volumeResult.errors);
      }

      // Download volumes from S3 to temp directories
      if (volumeResult.volumes.length > 0) {
        tempDir = `/tmp/vm0-run-${runId}`;
        await fs.promises.mkdir(tempDir, { recursive: true });

        console.log(
          `[E2B] Downloading ${volumeResult.volumes.length} volumes...`,
        );

        for (const volume of volumeResult.volumes) {
          try {
            const localPath = path.join(tempDir, volume.name);
            const downloadResult = await downloadS3Directory(
              volume.s3Uri,
              localPath,
            );
            console.log(
              `[E2B] Downloaded volume "${volume.name}": ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
            );
          } catch (error) {
            console.error(
              `[E2B] Failed to download volume "${volume.name}":`,
              error,
            );
          }
        }
      }

      // Create E2B sandbox with environment variables
      sandbox = await this.createSandbox({
        VM0_API_URL: apiUrl,
        VM0_WEBHOOK_URL: webhookEndpoint,
        VM0_RUN_ID: runId,
        VM0_WEBHOOK_TOKEN: options.sandboxToken, // Temporary bearer token for webhook authentication
      });
      console.log(`[E2B] Sandbox created: ${sandbox.sandboxId}`);

      // Upload volumes to sandbox
      if (volumeResult.volumes.length > 0 && tempDir) {
        console.log(
          `[E2B] Uploading ${volumeResult.volumes.length} volumes to sandbox...`,
        );

        for (const volume of volumeResult.volumes) {
          try {
            const localPath = path.join(tempDir, volume.name);
            // Check if directory exists before uploading
            if (await fs.promises.stat(localPath).catch(() => null)) {
              await this.uploadDirectoryToSandbox(
                sandbox,
                localPath,
                volume.mountPath,
              );
              console.log(
                `[E2B] Uploaded volume "${volume.name}" to ${volume.mountPath}`,
              );
            }
          } catch (error) {
            console.error(
              `[E2B] Failed to upload volume "${volume.name}":`,
              error,
            );
          }
        }
      }

      // Execute Claude Code via run-agent.sh
      const result = await this.executeCommand(
        sandbox,
        runId,
        options.prompt,
        webhookEndpoint,
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
      if (tempDir) {
        try {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
          console.log(`[E2B] Cleaned up temp directory: ${tempDir}`);
        } catch (error) {
          console.error(`[E2B] Failed to cleanup temp directory:`, error);
        }
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
      timeoutMs: 3_600_000, // 1 hour timeout to allow for long-running operations
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
    agentConfig?: unknown,
  ): Promise<SandboxExecutionResult> {
    const execStart = Date.now();

    // Use pre-installed run-agent.sh script from /usr/local/bin/
    // The script is copied into the E2B template during build (see e2b/template.ts)
    const scriptPath = "/usr/local/bin/run-agent.sh";

    console.log(`[E2B] Executing run-agent.sh for run ${runId}...`);

    // Extract working_dir from agent config
    const config = agentConfig as AgentConfigYaml | undefined;
    const workingDir = config?.agent?.working_dir;

    // Set environment variables and execute script
    const envs: Record<string, string> = {
      VM0_RUN_ID: runId,
      VM0_WEBHOOK_URL: webhookUrl,
      VM0_WEBHOOK_TOKEN: sandboxToken,
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
