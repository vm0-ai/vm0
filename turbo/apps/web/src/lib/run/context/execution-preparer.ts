import { eq } from "drizzle-orm";
import type { AgentComposeYaml } from "../../../types/agent-compose";
import type { ExecutionContext, RuntimeOrg } from "../types";
import type { PreparedContext } from "../executors/types";
import {
  prepareStorageManifest,
  ensureStorageExists,
} from "../../storage/storage-service";
import type { StorageManifest } from "../../storage/types";
import { badRequest } from "../../errors";
import { logger } from "../../logger";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { getOrgData } from "../../scope/org-cache-service";
import { extractCliAgentType } from "../utils";

const log = logger("context:preparer");

/**
 * Extract working directory from agent compose config
 * This is required for resume and storage operations
 */
function extractWorkingDir(agentCompose: unknown): string {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) {
    throw badRequest(
      "Agent must have working_dir configured (no default allowed)",
    );
  }
  const agents = Object.values(compose.agents);
  const workingDir = agents[0]?.working_dir;
  if (!workingDir) {
    throw badRequest(
      "Agent must have working_dir configured (no default allowed)",
    );
  }
  return workingDir;
}

/**
 * Resolve runner group from agent compose config
 */
function resolveRunnerGroup(agentCompose: unknown): string | null {
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
interface PrepareTimings {
  resolveOrgs: number;
  ensureStorage: number;
  storageManifest: number;
}

interface PrepareResult {
  context: PreparedContext;
  timings: PrepareTimings;
}

export async function prepareForExecution(
  context: ExecutionContext,
  runtimeOrg: RuntimeOrg,
): Promise<PrepareResult> {
  log.debug(`Preparing execution context for run ${context.runId}...`);

  // Extract configuration from agent compose
  const workingDir = extractWorkingDir(context.agentCompose);
  const cliAgentType = extractCliAgentType(context.agentCompose);
  const runnerGroup = resolveRunnerGroup(context.agentCompose);

  log.debug(
    `Extracted config: workingDir=${workingDir}, cliAgentType=${cliAgentType}, runnerGroup=${runnerGroup}`,
  );

  // Resolve the Agent Scope for volume resolution.
  // Runtime Scope (for artifacts/memory) is pre-resolved by buildExecutionContext.
  const userId = context.userId || "";
  const scopeStart = Date.now();
  const [agentComposeInfo] = await globalThis.services.db
    .select({
      orgId: agentComposes.orgId,
    })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(eq(agentComposeVersions.id, context.agentComposeVersionId))
    .limit(1);
  const scopeEnd = Date.now();

  if (!agentComposeInfo) {
    throw badRequest("Agent compose not found");
  }

  const agentOrgData = await getOrgData(agentComposeInfo.orgId);
  const agentScopeInfo = {
    orgId: agentComposeInfo.orgId,
    orgSlug: agentOrgData.slug,
  };

  // Auto-create artifact and memory storages if they don't exist yet
  const ensureStart = Date.now();
  await Promise.all([
    context.artifactName
      ? ensureStorageExists(
          runtimeOrg.orgId,
          userId,
          context.artifactName,
          runtimeOrg.slug,
          "artifact",
        )
      : null,
    context.memoryName
      ? ensureStorageExists(
          runtimeOrg.orgId,
          userId,
          context.memoryName,
          runtimeOrg.slug,
          "memory",
        )
      : null,
  ]);
  const ensureEnd = Date.now();

  // Prepare storage manifest with dual scopes (see docs/resource-model.md)
  // - Volumes: resolved from Agent Scope
  // - Artifacts/Memory: resolved from Runtime Scope
  const storageStart = Date.now();
  const storageManifest = await prepareStorageManifest(
    context.agentCompose as AgentComposeYaml,
    context.vars || {},
    agentScopeInfo.orgId,
    runtimeOrg.orgId,
    userId,
    context.artifactName,
    context.artifactVersion,
    context.volumeVersions,
    context.resumeArtifact,
    workingDir,
    context.memoryName,
  );
  const storageEnd = Date.now();

  log.debug(
    `Storage manifest prepared with dual scopes: agentClerkOrgId=${agentScopeInfo.orgId}, runtimeClerkOrgId=${runtimeOrg.orgId}, ${storageManifest.storages.length} storages, ${storageManifest.artifact ? "1 artifact" : "no artifact"}`,
  );

  // Build PreparedContext
  const preparedContext = buildPreparedContext(
    context,
    workingDir,
    cliAgentType,
    runnerGroup,
    storageManifest,
    agentScopeInfo.orgSlug,
  );

  const timings: PrepareTimings = {
    resolveOrgs: scopeEnd - scopeStart,
    ensureStorage: ensureEnd - ensureStart,
    storageManifest: storageEnd - storageStart,
  };

  log.debug(
    `PreparedContext built for run ${context.runId} (scopes=${timings.resolveOrgs}ms, ensure=${timings.ensureStorage}ms, storage=${timings.storageManifest}ms)`,
  );

  return { context: preparedContext, timings };
}

/**
 * Build PreparedContext from ExecutionContext and extracted configuration
 */
function buildPreparedContext(
  context: ExecutionContext,
  workingDir: string,
  cliAgentType: string,
  runnerGroup: string | null,
  storageManifest: StorageManifest,
  agentScopeSlug: string | null,
): PreparedContext {
  return {
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
    // Resume support
    resumeSession: context.resumeSession || null,
    resumeArtifact: context.resumeArtifact || null,

    // Artifact settings
    artifactName: context.artifactName || null,
    artifactVersion: context.artifactVersion || null,

    // Memory storage name
    memoryName: context.memoryName || null,

    // Experimental services for proxy-side token replacement
    experimentalServices: context.experimentalServices ?? null,

    // Routing
    runnerGroup,

    // Metadata
    agentName: context.agentName || null,
    agentScopeSlug,
    resumedFromCheckpointId: context.resumedFromCheckpointId || null,
    continuedFromSessionId: context.continuedFromSessionId || null,

    // Debug flag
    debugNoMockClaude: context.debugNoMockClaude || false,

    // API start time for E2E timing metrics
    apiStartTime: context.apiStartTime ?? null,

    // User timezone preference
    userTimezone: context.userTimezone || null,
  };
}
