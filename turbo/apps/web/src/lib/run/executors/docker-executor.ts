import {
  createDockerSandbox,
  resolveApiUrlForSandbox,
} from "../../docker/docker-sandbox";
import { env } from "../../../env";
import type { SandboxLike } from "../../docker/docker-sandbox";
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

const log = logger("executor:docker");

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
      sandboxType: "docker",
      actionType,
      durationMs: Date.now() - startTime,
      success,
    });
  }
}

export function getFirstAgent(
  compose?: AgentComposeYaml,
): AgentComposeYaml["agents"][string] | undefined {
  if (!compose?.agents) return undefined;
  const values = Object.values(compose.agents);
  return values[0];
}

/**
 * Execute an agent run in a Docker sandbox container.
 *
 * This is the Docker equivalent of executeE2bRun(). It creates a container,
 * uploads scripts, downloads storages, and starts the agent process.
 *
 * The container joins the same Docker network as the web service so the
 * agent can call back to the Web API via http://web:3000.
 */
export async function executeDockerRun(
  context: PreparedContext,
): Promise<ExecutorResult> {
  if (context.apiStartTime) {
    recordSandboxOperation({
      sandboxType: "docker",
      actionType: "api_to_executor",
      durationMs: Date.now() - context.apiStartTime,
      success: true,
    });
  }

  const startTime = Date.now();
  const isResume = !!context.resumeSession;

  log.debug(
    `${isResume ? "Resuming" : "Creating"} run ${context.runId} in Docker sandbox...`,
  );

  let sandbox: SandboxLike | null = null;
  const agentComposeYaml = context.agentCompose as AgentComposeYaml | undefined;

  let currentStep = "init";

  try {
    // Update run status to "running"
    currentStep = "update_run_status";
    await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "running",
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      })
      .where(eq(agentRuns.id, context.runId));

    const storageManifest = context.storageManifest;

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

    // Build environment variables
    const sandboxEnvVars = await buildSandboxEnvVars(
      context,
      artifactForCommand,
    );

    // Determine sandbox image
    const agent = getFirstAgent(agentComposeYaml);
    const image = agent?.image || "vm0-sandbox:latest";

    // Create sandbox container
    currentStep = "vm_create";
    sandbox = await withSandboxMetrics("vm_create", () =>
      createDockerSandbox(image, { envs: sandboxEnvVars }),
    );
    log.debug(`Docker sandbox created: ${sandbox.sandboxId}`);

    // Persist sandboxId immediately (before agent start to avoid race)
    currentStep = "persist_sandbox_id";
    await globalThis.services.db
      .update(agentRuns)
      .set({ sandboxId: sandbox.sandboxId })
      .where(eq(agentRuns.id, context.runId));
    log.debug(
      `SandboxId ${sandbox.sandboxId} persisted for run ${context.runId}`,
    );

    // Upload scripts
    currentStep = "script_upload";
    log.debug(`[${context.runId}] Uploading scripts to sandbox...`);
    await withSandboxMetrics("script_upload", () => uploadAllScripts(sandbox!));
    log.debug(`[${context.runId}] Scripts uploaded successfully`);

    // Download storages
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
      `Run ${context.runId} Docker sandbox prepared in ${prepTimeMs}ms, agent execution started`,
    );

    return {
      runId: context.runId,
      status: "running",
      sandboxId: sandbox.sandboxId,
      createdAt: new Date(startTime).toISOString(),
    };
  } catch (error) {
    let errorMessage = error instanceof Error ? error.message : "Unknown error";

    const errorWithResult = error as { result?: { stderr?: string } };
    if (errorWithResult.result?.stderr) {
      errorMessage = errorWithResult.result.stderr;
    }

    const fullErrorMessage = `[${currentStep}] ${errorMessage}`;
    log.error(
      `Run ${context.runId} failed at step '${currentStep}':`,
      errorMessage,
    );

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

    if (sandbox) {
      await cleanupSandbox(sandbox);
    }

    const enhancedError = new Error(fullErrorMessage);
    if (errorWithResult.result) {
      (enhancedError as { result?: { stderr?: string } }).result = {
        stderr: fullErrorMessage,
      };
    }
    throw enhancedError;
  }
}

// ============ Env Vars ============

/**
 * Build environment variables for the Docker sandbox.
 * Unlike E2B, the API URL must be resolved at runtime for Docker networking.
 */
async function buildSandboxEnvVars(
  context: PreparedContext,
  artifactForCommand: PreparedArtifact | null,
): Promise<Record<string, string>> {
  const apiUrl = await resolveApiUrlForSandbox();

  const sandboxEnvVars: Record<string, string> = {
    VM0_API_URL: apiUrl,
    VM0_RUN_ID: context.runId,
    VM0_API_TOKEN: context.sandboxToken,
    VM0_PROMPT: context.prompt,
    VM0_WORKING_DIR: context.workingDir,
    VM0_API_START_TIME: context.apiStartTime?.toString() ?? "",
    CLI_AGENT_TYPE: context.cliAgentType,
  };

  if (context.resumeSession?.sessionId) {
    sandboxEnvVars.VM0_RESUME_SESSION_ID = context.resumeSession.sessionId;
  }

  if (env().USE_MOCK_CLAUDE === "true" && !context.debugNoMockClaude) {
    sandboxEnvVars.USE_MOCK_CLAUDE = "true";
  }

  if (artifactForCommand) {
    sandboxEnvVars.VM0_ARTIFACT_DRIVER = "vas";
    sandboxEnvVars.VM0_ARTIFACT_MOUNT_PATH = artifactForCommand.mountPath;
    sandboxEnvVars.VM0_ARTIFACT_VOLUME_NAME = artifactForCommand.vasStorageName;
    sandboxEnvVars.VM0_ARTIFACT_VERSION_ID = artifactForCommand.vasVersionId;
  }

  if (context.environment) {
    for (const [key, value] of Object.entries(context.environment)) {
      sandboxEnvVars[key] = value;
    }
  }

  if (context.secrets && Object.keys(context.secrets).length > 0) {
    const secretValues = Object.values(context.secrets);
    const encodedValues = secretValues.map((v) =>
      Buffer.from(v).toString("base64"),
    );
    sandboxEnvVars.VM0_SECRET_VALUES = encodedValues.join(",");
  }

  return sandboxEnvVars;
}

// ============ Script Upload ============

function getAllScripts(): Array<{ content: string; path: string }> {
  return [
    { content: RUN_AGENT_SCRIPT, path: SCRIPT_PATHS.runAgent },
    { content: DOWNLOAD_SCRIPT, path: SCRIPT_PATHS.download },
    { content: MOCK_CLAUDE_SCRIPT, path: SCRIPT_PATHS.mockClaude },
  ];
}

export function createScriptsTarBuffer(
  scripts: Array<{ content: string; path: string }>,
): Buffer {
  const BLOCK_SIZE = 512;
  const blocks: Buffer[] = [];

  for (const script of scripts) {
    const content = Buffer.from(script.content, "utf-8");
    const filePath = script.path.startsWith("/")
      ? script.path.slice(1)
      : script.path;

    const header = Buffer.alloc(BLOCK_SIZE, 0);
    header.write(filePath, 0, 100, "utf-8");
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

async function uploadAllScripts(sandbox: SandboxLike): Promise<void> {
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

// ============ Storage Download ============

async function downloadStoragesDirectly(
  sandbox: SandboxLike,
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

// ============ Session Restore ============

async function restoreSessionHistory(
  sandbox: SandboxLike,
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

// ============ Agent Start / Cleanup ============

async function startAgentExecution(
  sandbox: SandboxLike,
  runId: string,
): Promise<void> {
  const cmd = `nohup node ${SCRIPT_PATHS.runAgent} > /tmp/vm0-main-${runId}.log 2>&1 &`;
  await sandbox.commands.run(cmd);
}

async function cleanupSandbox(sandbox: SandboxLike): Promise<void> {
  try {
    log.debug(`Cleaning up sandbox ${sandbox.sandboxId}...`);
    await sandbox.kill();
  } catch (error) {
    log.error(`Failed to cleanup sandbox ${sandbox.sandboxId}:`, error);
  }
}
