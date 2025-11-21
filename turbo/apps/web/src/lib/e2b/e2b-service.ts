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
import {
  downloadGitHubDirectory,
  uploadGitHubDirectory,
} from "../github/github-client";
import type { AgentVolumeConfig } from "../volume/types";
import type { AgentConfigYaml } from "../../types/agent-config";
import type { VolumeMetadata } from "./types";
import type { VolumeSnapshot } from "../../db/schema/agent-checkpoint";
import { agentCheckpoints } from "../../db/schema/agent-checkpoint";
import { eq } from "drizzle-orm";
import { RUN_AGENT_SCRIPT } from "./run-agent-script";
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
   * Download directory contents from E2B sandbox recursively
   */
  private async downloadDirectoryFromSandbox(
    sandbox: Sandbox,
    remotePath: string,
    localDir: string,
  ): Promise<void> {
    // List directory contents
    const entries = await sandbox.files.list(remotePath);

    // Create local directory
    await fs.promises.mkdir(localDir, { recursive: true });

    for (const entry of entries) {
      const remoteFilePath = path.posix.join(remotePath, entry.name);
      const localPath = path.join(localDir, entry.name);

      if (entry.type === "dir") {
        await this.downloadDirectoryFromSandbox(
          sandbox,
          remoteFilePath,
          localPath,
        );
      } else {
        const content = await sandbox.files.read(remoteFilePath);
        // Convert ArrayBuffer to Buffer
        const buffer = Buffer.from(content);
        await fs.promises.writeFile(localPath, buffer);
      }
    }
  }

  /**
   * Restore checkpoint state - load checkpoint data from database
   */
  private async loadCheckpoint(checkpointId: string): Promise<{
    sessionId: string;
    sessionContent: string;
    volumeSnapshots: VolumeSnapshot[];
    workingDirectory: string;
    encodedPath: string;
  }> {
    console.log(`[E2B] Loading checkpoint ${checkpointId}...`);

    // Load checkpoint from database
    const [checkpoint] = await globalThis.services.db
      .select()
      .from(agentCheckpoints)
      .where(eq(agentCheckpoints.id, checkpointId))
      .limit(1);

    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    console.log(
      `[E2B] Loaded checkpoint from database (${checkpoint.sessionContent.length} bytes)`,
    );

    return {
      sessionId: checkpoint.sessionId,
      sessionContent: checkpoint.sessionContent,
      volumeSnapshots: checkpoint.volumeSnapshots as VolumeSnapshot[],
      workingDirectory: checkpoint.workingDirectory,
      encodedPath: checkpoint.encodedPath,
    };
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
    let checkpointData: Awaited<ReturnType<typeof this.loadCheckpoint>> | null =
      null;

    try {
      // Load checkpoint if resuming
      if (options.checkpointId) {
        checkpointData = await this.loadCheckpoint(options.checkpointId);
        console.log(
          `[E2B] Resuming from checkpoint ${options.checkpointId} with session ${checkpointData.sessionId}`,
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

      // Resolve volumes from agent config
      const agentConfig = options.agentConfig as AgentVolumeConfig | undefined;
      const volumeResult = agentConfig
        ? resolveVolumes(agentConfig, options.dynamicVars || {})
        : { volumes: [], errors: [] };

      // Log volume resolution errors but don't fail the run
      if (volumeResult.errors.length > 0) {
        console.warn(`[E2B] Volume resolution errors:`, volumeResult.errors);
      }

      // Download volumes - use checkpoint snapshots if resuming
      if (volumeResult.volumes.length > 0 || checkpointData) {
        tempDir = `/tmp/vm0-run-${runId}`;
        await fs.promises.mkdir(tempDir, { recursive: true });

        // If resuming, download from checkpoint snapshots
        if (checkpointData) {
          console.log(
            `[E2B] Restoring ${checkpointData.volumeSnapshots.length} volumes from checkpoint...`,
          );

          for (const snapshot of checkpointData.volumeSnapshots) {
            try {
              const localPath = path.join(tempDir, snapshot.volumeName);

              if (snapshot.driver === "git" && snapshot.commitSha) {
                if (!options.userId) {
                  throw new Error(
                    "userId is required for git volume driver but was not provided",
                  );
                }

                // Find the volume config to get the token
                const volumeConfig = volumeResult.volumes.find(
                  (v) => v.name === snapshot.volumeName,
                );
                if (!volumeConfig) {
                  console.warn(
                    `[E2B] Volume "${snapshot.volumeName}" not found in agent config, skipping`,
                  );
                  continue;
                }

                // Download from specific commit
                const gitUri = `${snapshot.uri}#${snapshot.commitSha}`;
                const downloadResult = await downloadGitHubDirectory(
                  gitUri,
                  localPath,
                  volumeConfig.metadata.token as string,
                  options.userId,
                  env().ENCRYPTION_SECRET,
                );
                console.log(
                  `[E2B] Restored Git volume "${snapshot.volumeName}" from commit ${snapshot.commitSha}: ${downloadResult.filesDownloaded} files`,
                );
              }
            } catch (error) {
              console.error(
                `[E2B] Failed to restore volume "${snapshot.volumeName}":`,
                error,
              );
            }
          }
        } else {
          // Normal volume download (not resuming)
          console.log(
            `[E2B] Downloading ${volumeResult.volumes.length} volumes...`,
          );

          for (const volume of volumeResult.volumes) {
            try {
              const localPath = path.join(tempDir, volume.name);

              if (volume.driver === "s3fs") {
                const downloadResult = await downloadS3Directory(
                  volume.uri,
                  localPath,
                );
                console.log(
                  `[E2B] Downloaded S3 volume "${volume.name}": ${downloadResult.filesDownloaded} files, ${downloadResult.totalBytes} bytes`,
                );
              } else if (volume.driver === "git") {
                if (!options.userId) {
                  throw new Error(
                    "userId is required for git volume driver but was not provided",
                  );
                }
                const downloadResult = await downloadGitHubDirectory(
                  volume.uri,
                  localPath,
                  volume.metadata.token as string,
                  options.userId,
                  env().ENCRYPTION_SECRET,
                );
                console.log(
                  `[E2B] Downloaded Git volume "${volume.name}": ${downloadResult.filesDownloaded} files, ${downloadResult.bytesDownloaded} bytes, commit: ${downloadResult.commitSha}`,
                );
              }
            } catch (error) {
              console.error(
                `[E2B] Failed to download volume "${volume.name}":`,
                error,
              );
            }
          }
        }
      }

      // Create E2B sandbox with environment variables
      const sandboxEnvVars: Record<string, string> = {
        VM0_API_URL: apiUrl,
        VM0_WEBHOOK_URL: webhookEndpoint,
        VM0_RUN_ID: runId,
        VM0_WEBHOOK_TOKEN: options.sandboxToken, // Temporary bearer token for webhook authentication
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

      // Restore session file if resuming from checkpoint
      if (checkpointData) {
        const sessionDir = `~/.config/claude/projects/${checkpointData.encodedPath}`;
        const sessionFilePath = `${sessionDir}/${checkpointData.sessionId}.jsonl`;

        console.log(
          `[E2B] Restoring session file to ${sessionFilePath} in sandbox...`,
        );

        // Create directory structure
        await sandbox.commands.run(`mkdir -p ${sessionDir}`);

        // Upload session file from database content
        const buffer = Buffer.from(checkpointData.sessionContent, "utf-8");
        const arrayBuffer = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer;
        await sandbox.files.write(sessionFilePath, arrayBuffer);

        console.log(
          `[E2B] Session file restored (${checkpointData.sessionContent.length} bytes)`,
        );
      }

      // Execute Claude Code via run-agent.sh
      const result = await this.executeCommand(
        sandbox,
        runId,
        options.prompt,
        webhookEndpoint,
        options.sandboxToken,
        options.agentConfig,
        checkpointData?.sessionId,
      );

      const executionTimeMs = Date.now() - startTime;
      const completedAt = new Date();

      console.log(`[E2B] Run ${runId} completed in ${executionTimeMs}ms`);

      // Upload modified volumes back to storage (Git volumes only)
      const volumeMetadata: VolumeMetadata[] = [];

      if (volumeResult.volumes.length > 0 && result.exitCode === 0 && tempDir) {
        console.log(
          `[E2B] Uploading modified volumes for ${volumeResult.volumes.length} volume(s)...`,
        );

        for (const volume of volumeResult.volumes) {
          try {
            if (volume.driver === "git") {
              if (!options.userId) {
                console.warn(
                  `[E2B] Skipping upload for Git volume "${volume.name}": userId not provided`,
                );
                continue;
              }

              // Download modified workspace from sandbox
              const localPath = path.join(tempDir, `${volume.name}-modified`);
              await this.downloadDirectoryFromSandbox(
                sandbox,
                volume.mountPath,
                localPath,
              );
              console.log(
                `[E2B] Downloaded modified volume "${volume.name}" from sandbox`,
              );

              // Upload to GitHub with run-specific branch
              const branch = `run-${runId}`;
              const commitMessage = `Agent run ${runId}\n\nPrompt: ${options.prompt}\n\nAutomated commit from VM0 agent`;

              const uploadResult = await uploadGitHubDirectory(
                localPath,
                volume.uri,
                branch,
                commitMessage,
                volume.metadata.token as string,
                options.userId,
                env().ENCRYPTION_SECRET,
              );

              console.log(
                `[E2B] Uploaded volume "${volume.name}" to branch "${branch}", commit: ${uploadResult.commitSha}`,
              );

              volumeMetadata.push({
                volumeName: volume.name,
                driver: "git",
                commitSha: uploadResult.commitSha,
                branch: uploadResult.branch,
                repo: volume.metadata.repo as string,
              });
            }
          } catch (error) {
            console.error(
              `[E2B] Failed to upload volume "${volume.name}":`,
              error,
            );
          }
        }
      }

      return {
        runId,
        sandboxId: sandbox.sandboxId,
        status: result.exitCode === 0 ? "completed" : "failed",
        output: result.stdout,
        error: result.exitCode !== 0 ? result.stderr : undefined,
        executionTimeMs,
        createdAt: new Date(startTime),
        completedAt,
        volumeMetadata: volumeMetadata.length > 0 ? volumeMetadata : undefined,
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
    webhookUrl: string,
    sandboxToken: string,
    agentConfig?: unknown,
    sessionId?: string,
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
      VM0_WEBHOOK_URL: webhookUrl,
      VM0_WEBHOOK_TOKEN: sandboxToken,
      VM0_PROMPT: prompt,
    };

    // Add session ID if resuming from checkpoint
    if (sessionId) {
      envs.VM0_SESSION_ID = sessionId;
      console.log(`[E2B] Resuming session: ${sessionId}`);
    }

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
