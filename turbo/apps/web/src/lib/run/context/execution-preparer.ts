import type { AgentComposeYaml } from "../../../types/agent-compose";
import type { ExecutionContext } from "../types";
import type { PreparedContext } from "../executors/types";
import { storageService } from "../../storage/storage-service";
import { BadRequestError } from "../../errors";
import { logger } from "../../logger";

const log = logger("context:preparer");

/**
 * Extract working directory from agent compose config
 * This is required for resume and storage operations
 */
export function extractWorkingDir(agentCompose: unknown): string {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) {
    throw new BadRequestError(
      "Agent must have working_dir configured (no default allowed)",
    );
  }
  const agents = Object.values(compose.agents);
  const workingDir = agents[0]?.working_dir;
  if (!workingDir) {
    throw new BadRequestError(
      "Agent must have working_dir configured (no default allowed)",
    );
  }
  return workingDir;
}

/**
 * Extract CLI agent type from agent compose config
 */
export function extractCliAgentType(agentCompose: unknown): string {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return "claude-code";
  const agents = Object.values(compose.agents);
  return agents[0]?.provider || "claude-code";
}

/**
 * Resolve runner group from agent compose config
 */
export function resolveRunnerGroup(agentCompose: unknown): string | null {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return null;
  const agents = Object.values(compose.agents);
  return agents[0]?.experimental_runner?.group ?? null;
}

/**
 * Prepare execution context for executors
 *
 * This function transforms an ExecutionContext into a PreparedContext
 * by extracting additional information from the agent compose config
 * and preparing the storage manifest.
 *
 * @param context ExecutionContext built by run-service
 * @returns PreparedContext ready for executor dispatch
 */
export async function prepareForExecution(
  context: ExecutionContext,
): Promise<PreparedContext> {
  log.debug(`Preparing execution context for run ${context.runId}...`);

  // Extract configuration from agent compose
  const workingDir = extractWorkingDir(context.agentCompose);
  const cliAgentType = extractCliAgentType(context.agentCompose);
  const runnerGroup = resolveRunnerGroup(context.agentCompose);

  log.debug(
    `Extracted config: workingDir=${workingDir}, cliAgentType=${cliAgentType}, runnerGroup=${runnerGroup}`,
  );

  // Prepare storage manifest with presigned URLs
  // This is done ONCE here, not in each executor
  const storageManifest = await storageService.prepareStorageManifest(
    context.agentCompose as AgentComposeYaml,
    context.vars || {},
    context.userId || "",
    context.artifactName,
    context.artifactVersion,
    context.volumeVersions,
    context.resumeArtifact,
    workingDir,
  );

  log.debug(
    `Storage manifest prepared: ${storageManifest.storages.length} storages, ${storageManifest.artifact ? "1 artifact" : "no artifact"}`,
  );

  // Build PreparedContext
  const preparedContext: PreparedContext = {
    // Identity
    runId: context.runId,
    userId: context.userId || "",
    sandboxToken: context.sandboxToken,

    // What to run
    prompt: context.prompt,
    agentComposeVersionId: context.agentComposeVersionId,
    agentCompose: context.agentCompose,
    cliAgentType,
    workingDir,

    // Storage
    storageManifest,

    // Environment & Secrets
    environment: context.environment || null,
    secrets: context.secrets || null,
    secretNames: context.secretNames || null,

    // Resume support
    resumeSession: context.resumeSession || null,
    resumeArtifact: context.resumeArtifact || null,

    // Artifact settings
    artifactName: context.artifactName || null,
    artifactVersion: context.artifactVersion || null,

    // Network security
    experimentalNetworkSecurity: context.experimentalNetworkSecurity || false,

    // Routing
    runnerGroup,

    // Metadata
    agentName: context.agentName || null,
    resumedFromCheckpointId: context.resumedFromCheckpointId || null,
    continuedFromSessionId: context.continuedFromSessionId || null,
  };

  log.debug(`PreparedContext built for run ${context.runId}`);

  return preparedContext;
}
