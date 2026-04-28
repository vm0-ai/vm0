import { eq } from "drizzle-orm";
import type { AgentComposeYaml } from "../../agent-compose/types";
import type { ExecutionContext } from "../types";
import type { PreparedContext } from "../executors/types";
import {
  prepareStorageManifest,
  ensureStorageExists,
} from "../../../infra/storage/storage-service";
import type { StorageManifest } from "../../../infra/storage/types";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { DEFAULT_PROFILE } from "@vm0/api-contracts/contracts/runners";
import { badRequest } from "@vm0/api-services/errors";
import { logger } from "../../../shared/logger";
import { extractWorkingDir } from "../utils/extract-working-dir";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { extractCliAgentType } from "../utils";

const log = logger("context:preparer");

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
 * Known profiles. Must stay in sync with Rust: crates/runner/src/profile.rs
 */
const KNOWN_PROFILES = [DEFAULT_PROFILE];

/**
 * Resolve runner profile from agent compose config
 * Defaults to "vm0/default" when experimental_runner is set but profile is omitted.
 * Rejects unknown profiles with 400.
 */
function resolveRunnerProfile(agentCompose: unknown): string | null {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return null;
  const agents = Object.values(compose.agents);
  const profile = agents[0]?.experimental_profile;
  if (!profile) return null;
  if (!KNOWN_PROFILES.includes(profile)) {
    throw badRequest(
      `Unknown profile "${profile}". Valid profiles: ${KNOWN_PROFILES.join(", ")}`,
    );
  }
  return profile;
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
): Promise<PrepareResult> {
  const orgId = context.orgId;
  log.debug(`Preparing execution context for run ${context.runId}...`);

  // Extract configuration from agent compose
  const workingDir = extractWorkingDir(context.agentCompose);
  const cliAgentType = extractCliAgentType(context.agentCompose);
  const runnerGroup = resolveRunnerGroup(context.agentCompose);
  const profile = resolveRunnerProfile(context.agentCompose);

  log.debug(
    `Extracted config: workingDir=${workingDir}, cliAgentType=${cliAgentType}, runnerGroup=${runnerGroup}, profile=${profile}`,
  );

  // Resolve the Agent Org for volume resolution.
  // Runtime Org (for artifacts/memory) is pre-resolved by buildExecutionContext.
  const userId = context.userId || "";
  const orgStart = Date.now();
  const [agentComposeInfo] = await globalThis.services.db
    .select({
      orgId: agentComposes.orgId,
      composeId: agentComposes.id,
    })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(eq(agentComposeVersions.id, context.agentComposeVersionId))
    .limit(1);
  const orgEnd = Date.now();

  if (!agentComposeInfo) {
    throw badRequest("Agent compose not found");
  }

  const agentOrgId = agentComposeInfo.orgId;

  // Auto-create artifact storages if they don't exist yet. Every entry in the
  // unified artifact list already carries its own mountPath (zero synthesizes
  // the memory entry); infra creates one storage row per entry.
  const artifacts = context.artifacts ?? [];
  const ensureStart = Date.now();
  await Promise.all(
    artifacts.map((entry) => {
      return ensureStorageExists(orgId, userId, entry.name, "artifact");
    }),
  );
  const ensureEnd = Date.now();

  // Prepare storage manifest with dual orgs (see docs/resource-model.md)
  // - Volumes: resolved from Agent Org
  // - Artifacts/Memory: resolved from Runtime Org
  const storageStart = Date.now();
  const storageManifest = await prepareStorageManifest(
    context.agentCompose as AgentComposeYaml,
    context.vars || {},
    agentOrgId,
    orgId,
    userId,
    artifacts,
    context.volumeVersions,
    context.additionalVolumes,
  );
  const storageEnd = Date.now();

  log.debug(
    `Storage manifest prepared with dual orgs: agentClerkOrgId=${agentOrgId}, runtimeClerkOrgId=${orgId}, ${storageManifest.storages.length} storages, ${storageManifest.artifacts.length} artifacts`,
  );

  // Build PreparedContext
  const preparedContext = buildPreparedContext(
    context,
    workingDir,
    cliAgentType,
    runnerGroup,
    profile,
    storageManifest,
  );

  const timings: PrepareTimings = {
    resolveOrgs: orgEnd - orgStart,
    ensureStorage: ensureEnd - ensureStart,
    storageManifest: storageEnd - storageStart,
  };

  log.debug(
    `PreparedContext built for run ${context.runId} (orgs=${timings.resolveOrgs}ms, ensure=${timings.ensureStorage}ms, storage=${timings.storageManifest}ms)`,
  );

  return { context: preparedContext, timings };
}

/** Convert undefined to null (reduces branching in buildPreparedContext) */
function toNullable<T>(value: T | undefined | null): T | null {
  return value ?? null;
}

/**
 * Extract optional metadata fields from ExecutionContext, coalescing to null
 */
function extractMetadata(context: ExecutionContext) {
  return {
    resumedFromCheckpointId: context.resumedFromCheckpointId || null,
    continuedFromSessionId: context.continuedFromSessionId || null,
    apiStartTime: context.apiStartTime,
    userTimezone: context.userTimezone || null,
  };
}

/**
 * Build PreparedContext from ExecutionContext and extracted configuration
 */
function buildPreparedContext(
  context: ExecutionContext,
  workingDir: string,
  cliAgentType: string,
  runnerGroup: string | null,
  profile: string | null,
  storageManifest: StorageManifest,
): PreparedContext {
  const metadata = extractMetadata(context);

  return {
    // Identity
    runId: context.runId,
    userId: context.userId || "",
    sandboxToken: context.sandboxToken,

    // What to run
    prompt: context.prompt,
    appendSystemPrompt: toNullable(context.appendSystemPrompt),
    agentComposeVersionId: context.agentComposeVersionId,
    agentCompose: context.agentCompose,
    cliAgentType,
    workingDir,

    // Storage
    storageManifest,

    // Environment & Secrets
    environment: context.environment || null,
    secrets: context.secrets || null,
    secretConnectorMap: context.secretConnectorMap || null,
    // Resume support
    resumeSession: context.resumeSession || null,

    // Firewall for proxy-side token replacement
    firewalls: toNullable(context.firewalls),

    // Per-firewall network policies
    networkPolicies: toNullable(context.networkPolicies),

    // Disallowed tools
    disallowedTools: toNullable(context.disallowedTools),

    // Settings JSON
    settings: toNullable(context.settings),

    // Tools
    tools: context.tools ?? null,

    // Experimental profile
    experimentalProfile: profile,

    // Routing
    runnerGroup,

    // Feature flags (evaluated once at preparation time)
    featureFlags: getAllFeatureStates({
      userId: context.userId,
      orgId: context.orgId,
    }),

    // Metadata
    ...metadata,

    // Debug flag
    debugNoMockClaude: context.debugNoMockClaude || false,
    captureNetworkBodies: context.captureNetworkBodies || false,

    billableFirewalls: context.billableFirewalls,
    modelUsageProvider: context.modelUsageProvider ?? null,

    wasQueued: context.wasQueued ?? false,
  };
}
