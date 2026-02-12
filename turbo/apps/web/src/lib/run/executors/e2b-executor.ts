import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../../env";
import { e2bConfig } from "../../e2b/config";
import { resolveImageAlias } from "../../image/image-service";
import { badRequest } from "../../errors";
import type { AgentComposeYaml } from "../../../types/agent-compose";
import type { PreparedArtifact, StorageManifest } from "../../storage/types";
import {
  RUN_AGENT_SCRIPT,
  DOWNLOAD_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  SCRIPT_PATHS,
} from "@vm0/sandbox-scripts";
import { calculateSessionHistoryPath } from "../run-service";
import { logger } from "../../logger";
import { agentRuns } from "../../../db/schema/agent-run";
import { eq } from "drizzle-orm";
import type { PreparedContext, ExecutorResult } from "./types";
import { recordSandboxOperation } from "../../metrics";

const log = logger("executor:e2b");

/**
 * Helper to wrap async operations with sandbox metrics recording
 */
async function withSandboxMetrics<T>(
  actionType: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  let success = true;
  try {
    return await fn();
  } catch (error) {
    success = false;
    throw error;
  } finally {
    recordSandboxOperation({
      sandboxType: "e2b",
      actionType,
      durationMs: Date.now() - startTime,
      success,
    });
  }
}

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
 * Execute an agent run in E2B sandbox
 *
 * @param context PreparedContext with all necessary information
 * @returns ExecutorResult with status "running" and sandboxId
 */
export async function executeE2bRun(
  context: PreparedContext,
): Promise<ExecutorResult> {
  // Record api_to_dispatch metric
  if (context.apiStartTime) {
    recordSandboxOperation({
      sandboxType: "e2b",
      actionType: "api_to_executor",
      durationMs: Date.now() - context.apiStartTime,
      success: true,
    });
  }

  const startTime = Date.now();
  const isResume = !!context.resumeSession;

  log.debug(
    `${isResume ? "Resuming" : "Creating"} run ${context.runId} in E2B sandbox...`,
  );

  let sandbox: Sandbox | null = null;
  const agentComposeYaml = context.agentCompose as AgentComposeYaml | undefined;

  // Track current execution step for better error diagnostics
  let currentStep = "init";

  try {
    // Update run status to "running" before starting execution
    currentStep = "update_run_status";
    await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "running",
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      })
      .where(eq(agentRuns.id, context.runId));

    // Storage manifest is pre-prepared in PreparedContext
    const storageManifest = context.storageManifest;

    // Create artifact info for checkpoint from storage manifest
    const artifactForCommand: PreparedArtifact | null =
      storageManifest?.artifact
        ? {
            driver: "vas",
            mountPath: storageManifest.artifact.mountPath,
            vasStorageName: storageManifest.artifact.vasStorageName,
            vasVersionId: storageManifest.artifact.vasVersionId,
            manifestUrl: storageManifest.artifact.manifestUrl,
          }
        : null;

    // Build sandbox environment variables
    const sandboxEnvVars = buildSandboxEnvVars(context, artifactForCommand);

    // Create sandbox
    currentStep = "vm_create";
    sandbox = await withSandboxMetrics("vm_create", () =>
      createSandbox(sandboxEnvVars, agentComposeYaml, context.userId),
    );
    log.debug(`Sandbox created: ${sandbox.sandboxId}`);

    // Update sandboxId in database immediately after creation
    // This MUST happen BEFORE startAgentExecution() to avoid race condition
    currentStep = "persist_sandbox_id";
    await globalThis.services.db
      .update(agentRuns)
      .set({ sandboxId: sandbox.sandboxId })
      .where(eq(agentRuns.id, context.runId));
    log.debug(
      `SandboxId ${sandbox.sandboxId} persisted for run ${context.runId}`,
    );

    // Upload all scripts to sandbox
    currentStep = "script_upload";
    log.debug(`[${context.runId}] Uploading scripts to sandbox...`);
    await withSandboxMetrics("script_upload", () => uploadAllScripts(sandbox!));
    log.debug(`[${context.runId}] Scripts uploaded successfully`);

    // Download storages directly to sandbox
    if (storageManifest) {
      currentStep = "storage_download";
      log.debug(`[${context.runId}] Downloading storages to sandbox...`);
      await withSandboxMetrics("storage_download", () =>
        downloadStoragesDirectly(sandbox!, storageManifest),
      );
      log.debug(`[${context.runId}] Storages downloaded successfully`);
    }

    // Restore session history for resume
    if (context.resumeSession) {
      currentStep = "session_restore";
      await withSandboxMetrics("session_restore", () =>
        restoreSessionHistory(
          sandbox!,
          context.resumeSession!.sessionId,
          context.resumeSession!.sessionHistory,
          context.resumeSession!.workingDir,
          context.cliAgentType,
        ),
      );
    }

    // Start agent execution (fire-and-forget)
    currentStep = "agent_start";
    log.debug(`[${context.runId}] Starting agent execution...`);
    await withSandboxMetrics("agent_start", () =>
      startAgentExecution(sandbox!, context.runId),
    );
    log.debug(`[${context.runId}] Agent execution command sent`);

    const prepTimeMs = Date.now() - startTime;
    log.debug(
      `Run ${context.runId} sandbox prepared in ${prepTimeMs}ms, agent execution started`,
    );

    return {
      runId: context.runId,
      status: "running",
      sandboxId: sandbox.sandboxId,
      createdAt: new Date(startTime).toISOString(),
    };
  } catch (error) {
    // Extract error message
    let errorMessage = error instanceof Error ? error.message : "Unknown error";

    const errorWithResult = error as { result?: { stderr?: string } };
    if (errorWithResult.result?.stderr) {
      errorMessage = errorWithResult.result.stderr;
    }

    // Include the execution step in error message for better diagnostics
    const fullErrorMessage = `[${currentStep}] ${errorMessage}`;
    log.error(
      `Run ${context.runId} failed at step '${currentStep}':`,
      errorMessage,
    );

    // Update run status to failed
    try {
      await globalThis.services.db
        .update(agentRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          error: fullErrorMessage,
        })
        .where(eq(agentRuns.id, context.runId));
    } catch (e) {
      log.error(`Failed to update run status for ${context.runId}:`, e);
    }

    // Cleanup sandbox on failure
    if (sandbox) {
      await cleanupSandbox(sandbox);
    }

    // Re-throw error with step information for caller to handle
    // Preserve original error structure but add step prefix to message
    const enhancedError = new Error(fullErrorMessage);
    if (errorWithResult.result) {
      (enhancedError as { result?: { stderr?: string } }).result = {
        stderr: fullErrorMessage,
      };
    }
    throw enhancedError;
  }
}

/**
 * Build environment variables for sandbox
 */
function buildSandboxEnvVars(
  context: PreparedContext,
  artifactForCommand: PreparedArtifact | null,
): Record<string, string> {
  const vercelEnv = env().VERCEL_ENV;
  const vercelUrl = env().VERCEL_URL;

  let apiUrl = env().VM0_API_URL;
  if (!apiUrl) {
    if (vercelEnv === "preview" && vercelUrl) {
      apiUrl = `https://${vercelUrl}`;
    } else if (vercelEnv === "production") {
      apiUrl = "https://www.vm0.ai";
    } else {
      apiUrl = "http://localhost:3000";
    }
  }

  const sandboxEnvVars: Record<string, string> = {
    VM0_API_URL: apiUrl,
    VM0_RUN_ID: context.runId,
    VM0_API_TOKEN: context.sandboxToken,
    VM0_PROMPT: context.prompt,
    VM0_WORKING_DIR: context.workingDir,
    VM0_API_START_TIME: context.apiStartTime?.toString() ?? "",
    CLI_AGENT_TYPE: context.cliAgentType,
  };

  // Add Vercel protection bypass if available
  const vercelBypassSecret = env().VERCEL_AUTOMATION_BYPASS_SECRET;
  if (vercelBypassSecret) {
    sandboxEnvVars.VERCEL_PROTECTION_BYPASS = vercelBypassSecret;
  }

  // Add resume session ID if provided
  if (context.resumeSession?.sessionId) {
    sandboxEnvVars.VM0_RESUME_SESSION_ID = context.resumeSession.sessionId;
  }

  // Pass USE_MOCK_CLAUDE for testing (skip if debugNoMockClaude is set)
  if (env().USE_MOCK_CLAUDE === "true" && !context.debugNoMockClaude) {
    sandboxEnvVars.USE_MOCK_CLAUDE = "true";
  }

  // Add artifact information for checkpoint
  if (artifactForCommand) {
    sandboxEnvVars.VM0_ARTIFACT_DRIVER = "vas";
    sandboxEnvVars.VM0_ARTIFACT_MOUNT_PATH = artifactForCommand.mountPath;
    sandboxEnvVars.VM0_ARTIFACT_VOLUME_NAME = artifactForCommand.vasStorageName;
    sandboxEnvVars.VM0_ARTIFACT_VERSION_ID = artifactForCommand.vasVersionId;
  }

  // Add user-defined environment variables
  if (context.environment) {
    for (const [key, value] of Object.entries(context.environment)) {
      sandboxEnvVars[key] = value;
    }
  }

  // Pass secret values for client-side masking
  if (context.secrets && Object.keys(context.secrets).length > 0) {
    const secretValues = Object.values(context.secrets);
    const encodedValues = secretValues.map((v) =>
      Buffer.from(v).toString("base64"),
    );
    sandboxEnvVars.VM0_SECRET_VALUES = encodedValues.join(",");
  }

  return sandboxEnvVars;
}

/**
 * Create E2B sandbox
 */
async function createSandbox(
  envVars: Record<string, string>,
  agentCompose: AgentComposeYaml | undefined,
  userId: string,
): Promise<Sandbox> {
  const isVercelProduction = env().VERCEL_ENV === "production";
  const timeoutMs = isVercelProduction ? 7_200_000 : 3_600_000;

  const agent = getFirstAgent(agentCompose);
  const imageAlias = agent?.image || e2bConfig.defaultTemplate;

  if (!imageAlias) {
    throw badRequest(
      "No template specified. Set agent.image in vm0.config.yaml.",
    );
  }

  const resolved = await resolveImageAlias(userId, imageAlias);

  log.debug(`Using template: ${resolved.templateName}`);

  const sandbox = await Sandbox.create(resolved.templateName, {
    timeoutMs,
    envs: envVars,
  });

  return sandbox;
}

/**
 * Get all scripts to upload
 *
 * TypeScript bundled scripts - each is self-contained with all dependencies
 */
function getAllScripts(): Array<{ content: string; path: string }> {
  return [
    { content: RUN_AGENT_SCRIPT, path: SCRIPT_PATHS.runAgent },
    { content: DOWNLOAD_SCRIPT, path: SCRIPT_PATHS.download },
    { content: MOCK_CLAUDE_SCRIPT, path: SCRIPT_PATHS.mockClaude },
  ];
}

/**
 * Create tar archive for scripts
 */
function createScriptsTarBuffer(
  scripts: Array<{ content: string; path: string }>,
): Buffer {
  const BLOCK_SIZE = 512;
  const blocks: Buffer[] = [];

  for (const script of scripts) {
    const content = Buffer.from(script.content, "utf-8");
    const path = script.path.startsWith("/")
      ? script.path.slice(1)
      : script.path;

    const header = Buffer.alloc(BLOCK_SIZE, 0);
    header.write(path, 0, 100, "utf-8");
    header.write("0000755\0", 100, 8, "utf-8");
    header.write("0000000\0", 108, 8, "utf-8");
    header.write("0000000\0", 116, 8, "utf-8");

    const sizeOctal = content.length.toString(8).padStart(11, "0");
    header.write(sizeOctal + "\0", 124, 12, "utf-8");

    const mtime = Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0");
    header.write(mtime + "\0", 136, 12, "utf-8");

    header.write("        ", 148, 8, "utf-8");
    header.write("0", 156, 1, "utf-8");
    header.write("ustar\0", 257, 6, "utf-8");
    header.write("00", 263, 2, "utf-8");
    header.write("root", 265, 32, "utf-8");
    header.write("root", 297, 32, "utf-8");

    let checksum = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      checksum += header.readUInt8(i);
    }
    const checksumStr = checksum.toString(8).padStart(6, "0");
    header.write(checksumStr + "\0 ", 148, 8, "utf-8");

    blocks.push(header);
    blocks.push(content);

    const padding = BLOCK_SIZE - (content.length % BLOCK_SIZE);
    if (padding < BLOCK_SIZE) {
      blocks.push(Buffer.alloc(padding, 0));
    }
  }

  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(blocks);
}

/**
 * Upload all scripts to sandbox
 */
async function uploadAllScripts(sandbox: Sandbox): Promise<void> {
  const scripts = getAllScripts();
  const tarBuffer = createScriptsTarBuffer(scripts);
  const tarPath = "/tmp/vm0-scripts.tar";

  const arrayBuffer = tarBuffer.buffer.slice(
    tarBuffer.byteOffset,
    tarBuffer.byteOffset + tarBuffer.byteLength,
  ) as ArrayBuffer;

  await sandbox.files.write(tarPath, arrayBuffer);

  await sandbox.commands.run(
    `sudo mkdir -p ${SCRIPT_PATHS.baseDir} && ` +
      `cd / && sudo tar xf ${tarPath} && ` +
      `sudo chmod +x ${SCRIPT_PATHS.baseDir}/*.mjs 2>/dev/null || true && ` +
      `rm -f ${tarPath}`,
  );

  log.debug(`Uploaded ${scripts.length} scripts via tar bundle to sandbox`);
}

/**
 * Start agent execution (fire-and-forget)
 */
async function startAgentExecution(
  sandbox: Sandbox,
  runId: string,
): Promise<void> {
  const cmd = `nohup node ${SCRIPT_PATHS.runAgent} > /tmp/vm0-main-${runId}.log 2>&1 &`;
  await sandbox.commands.run(cmd);
}

/**
 * Download storages directly to sandbox
 */
async function downloadStoragesDirectly(
  sandbox: Sandbox,
  manifest: StorageManifest,
): Promise<void> {
  const totalArchives =
    manifest.storages.filter((s) => s.archiveUrl).length +
    (manifest.artifact?.archiveUrl ? 1 : 0);

  if (totalArchives === 0) {
    log.debug("No archives to download");
    return;
  }

  const manifestPath = "/tmp/storage-manifest.json";
  const manifestJson = JSON.stringify(manifest);
  const manifestBuffer = Buffer.from(manifestJson, "utf-8");
  const arrayBuffer = manifestBuffer.buffer.slice(
    manifestBuffer.byteOffset,
    manifestBuffer.byteOffset + manifestBuffer.byteLength,
  ) as ArrayBuffer;

  await sandbox.files.write(manifestPath, arrayBuffer);

  const result = await sandbox.commands.run(
    `node ${SCRIPT_PATHS.download} ${manifestPath}`,
    { timeoutMs: 300000 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Storage download failed: ${result.stderr}`);
  }

  log.debug(`Downloaded ${totalArchives} archives directly to sandbox`);
}

/**
 * Restore session history for resume
 */
async function restoreSessionHistory(
  sandbox: Sandbox,
  sessionId: string,
  sessionHistory: string,
  workingDir: string,
  agentType: string,
): Promise<void> {
  log.debug(`Restoring session history for ${sessionId}...`);

  const sessionHistoryPath = calculateSessionHistoryPath(
    workingDir,
    sessionId,
    agentType,
  );

  const dirPath = sessionHistoryPath.substring(
    0,
    sessionHistoryPath.lastIndexOf("/"),
  );
  await sandbox.commands.run(`mkdir -p "${dirPath}"`);

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
 * Cleanup sandbox on failure
 */
async function cleanupSandbox(sandbox: Sandbox): Promise<void> {
  try {
    log.debug(`Cleaning up sandbox ${sandbox.sandboxId}...`);
    await sandbox.kill();
  } catch (error) {
    log.error(`Failed to cleanup sandbox ${sandbox.sandboxId}:`, error);
  }
}
