import { eq } from "drizzle-orm";
import type {
  AgentComposeYaml,
  ExperimentalFirewall,
  FirewallRule,
} from "../../../types/agent-compose";
import type { ExecutionContext, RuntimeScope } from "../types";
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
import { scopes } from "../../../db/schema/scope";
import type { ExperimentalFirewall as CoreExperimentalFirewall } from "@vm0/core";
import { extractCliAgentType } from "../utils";

const log = logger("context:preparer");

/**
 * Framework to auto-injected domain mappings
 * These domains are automatically allowed when firewall is enabled
 */
const FRAMEWORK_AUTO_DOMAINS: Record<string, string[]> = {
  "claude-code": ["*.anthropic.com"],
  codex: ["*.openai.com"],
};

/**
 * Platform domains that are always auto-injected
 */
const PLATFORM_AUTO_DOMAINS = ["*.vm0.ai"];

/**
 * Storage domains that are always auto-injected
 * Required for downloading volumes/artifacts from cloud storage
 */
const STORAGE_AUTO_DOMAINS = [
  "*.cloudflarestorage.com", // Cloudflare R2
];

/**
 * Extract and process firewall configuration from agent compose
 * Auto-injects platform and provider domains
 */
function processFirewallConfig(
  agentCompose: unknown,
): CoreExperimentalFirewall | null {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return null;

  const agents = Object.values(compose.agents);
  const firstAgent = agents[0];
  if (!firstAgent?.experimental_firewall) return null;

  const firewallConfig =
    firstAgent.experimental_firewall as ExperimentalFirewall;
  if (!firewallConfig.enabled) return null;

  // Validate experimental_runner is configured (firewall requires runner)
  if (!firstAgent.experimental_runner?.group) {
    throw badRequest(
      "experimental_firewall requires experimental_runner to be configured",
    );
  }

  // Validate experimental_seal_secrets requires experimental_mitm
  if (
    firewallConfig.experimental_seal_secrets &&
    !firewallConfig.experimental_mitm
  ) {
    throw badRequest(
      "experimental_seal_secrets requires experimental_mitm to be enabled",
    );
  }

  // Build auto-injected rules
  const autoRules: FirewallRule[] = [];

  // 1. Add platform domains (highest priority)
  for (const domain of PLATFORM_AUTO_DOMAINS) {
    autoRules.push({ domain, action: "ALLOW" });
  }

  // 2. Add storage domains (required for volume/artifact downloads)
  for (const domain of STORAGE_AUTO_DOMAINS) {
    autoRules.push({ domain, action: "ALLOW" });
  }

  // 3. Add framework-specific domains
  const framework = firstAgent.framework;
  const frameworkDomains = FRAMEWORK_AUTO_DOMAINS[framework];
  if (frameworkDomains) {
    for (const domain of frameworkDomains) {
      autoRules.push({ domain, action: "ALLOW" });
    }
  }

  // 4. Add user-defined rules
  const userRules = firewallConfig.rules || [];

  // 5. Check if user has a final rule, if not add default DENY
  const hasFinalRule = userRules.some((rule) => rule.final !== undefined);
  const finalRule: FirewallRule = { final: "DENY" };

  // Build complete rules array
  const allRules: FirewallRule[] = [
    ...autoRules,
    ...userRules,
    ...(hasFinalRule ? [] : [finalRule]),
  ];

  log.debug(
    `Firewall config processed: ${autoRules.length} auto-injected, ${userRules.length} user rules, final=${hasFinalRule ? "user" : "default-deny"}`,
  );

  return {
    enabled: true,
    rules: allRules,
    experimental_mitm: firewallConfig.experimental_mitm ?? false,
    experimental_seal_secrets:
      firewallConfig.experimental_seal_secrets ?? false,
  };
}

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
  resolveScopes: number;
  ensureStorage: number;
  storageManifest: number;
}

interface PrepareResult {
  context: PreparedContext;
  timings: PrepareTimings;
}

export async function prepareForExecution(
  context: ExecutionContext,
  runtimeScope: RuntimeScope,
): Promise<PrepareResult> {
  log.debug(`Preparing execution context for run ${context.runId}...`);

  // Extract configuration from agent compose
  const workingDir = extractWorkingDir(context.agentCompose);
  const cliAgentType = extractCliAgentType(context.agentCompose);
  const runnerGroup = resolveRunnerGroup(context.agentCompose);

  // Process firewall configuration (validates and auto-injects rules)
  const experimentalFirewall = processFirewallConfig(context.agentCompose);

  log.debug(
    `Extracted config: workingDir=${workingDir}, cliAgentType=${cliAgentType}, runnerGroup=${runnerGroup}, firewall=${experimentalFirewall ? "enabled" : "disabled"}`,
  );

  // Resolve the Agent Scope for volume resolution.
  // Runtime Scope (for artifacts/memory) is pre-resolved by buildExecutionContext.
  const userId = context.userId || "";
  const scopeStart = Date.now();
  const [agentScopeInfo] = await globalThis.services.db
    .select({
      scopeId: scopes.id,
      scopeSlug: scopes.slug,
    })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .innerJoin(scopes, eq(agentComposes.scopeId, scopes.id))
    .where(eq(agentComposeVersions.id, context.agentComposeVersionId))
    .limit(1);
  const scopeEnd = Date.now();

  if (!agentScopeInfo) {
    throw badRequest("Agent compose not found");
  }

  // Auto-create artifact and memory storages if they don't exist yet
  const ensureStart = Date.now();
  await Promise.all([
    context.artifactName
      ? ensureStorageExists(
          runtimeScope.id,
          userId,
          context.artifactName,
          runtimeScope.slug,
          "artifact",
          runtimeScope.clerkOrgId,
        )
      : null,
    context.memoryName
      ? ensureStorageExists(
          runtimeScope.id,
          userId,
          context.memoryName,
          runtimeScope.slug,
          "memory",
          runtimeScope.clerkOrgId,
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
    agentScopeInfo.scopeId,
    runtimeScope.id,
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
    `Storage manifest prepared with dual scopes: agentScope=${agentScopeInfo.scopeId}, runtimeScope=${runtimeScope.id}, ${storageManifest.storages.length} storages, ${storageManifest.artifact ? "1 artifact" : "no artifact"}`,
  );

  // Build PreparedContext
  const preparedContext = buildPreparedContext(
    context,
    workingDir,
    cliAgentType,
    runnerGroup,
    storageManifest,
    experimentalFirewall,
    agentScopeInfo.scopeSlug,
  );

  const timings: PrepareTimings = {
    resolveScopes: scopeEnd - scopeStart,
    ensureStorage: ensureEnd - ensureStart,
    storageManifest: storageEnd - storageStart,
  };

  log.debug(
    `PreparedContext built for run ${context.runId} (scopes=${timings.resolveScopes}ms, ensure=${timings.ensureStorage}ms, storage=${timings.storageManifest}ms)`,
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
  experimentalFirewall: CoreExperimentalFirewall | null,
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
    secretNames: context.secretNames || null,

    // Resume support
    resumeSession: context.resumeSession || null,
    resumeArtifact: context.resumeArtifact || null,

    // Artifact settings
    artifactName: context.artifactName || null,
    artifactVersion: context.artifactVersion || null,

    // Memory storage name
    memoryName: context.memoryName || null,

    // Experimental firewall configuration (processed with auto-injected rules)
    experimentalFirewall,

    // Experimental connectors for proxy-side token replacement
    experimentalConnectors: context.experimentalConnectors ?? null,

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
