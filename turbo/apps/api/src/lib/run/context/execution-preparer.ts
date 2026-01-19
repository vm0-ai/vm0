import type {
  AgentComposeYaml,
  ExperimentalFirewall,
  FirewallRule,
} from "../../../types/agent-compose";
import type { ExecutionContext } from "../types";
import type { PreparedContext } from "../executors/types";
import { storageService } from "../../storage/storage-service";
import { BadRequestError } from "../../errors";
import { logger } from "../../logger";
import type { ExperimentalFirewall as CoreExperimentalFirewall } from "@vm0/core";

const log = logger("context:preparer");

/**
 * Provider to auto-injected domain mappings
 * These domains are automatically allowed when firewall is enabled
 */
const PROVIDER_AUTO_DOMAINS: Record<string, string[]> = {
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
    throw new BadRequestError(
      "experimental_firewall requires experimental_runner to be configured",
    );
  }

  // Validate experimental_seal_secrets requires experimental_mitm
  if (
    firewallConfig.experimental_seal_secrets &&
    !firewallConfig.experimental_mitm
  ) {
    throw new BadRequestError(
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

  // 3. Add provider-specific domains
  const provider = firstAgent.provider;
  const providerDomains = PROVIDER_AUTO_DOMAINS[provider];
  if (providerDomains) {
    for (const domain of providerDomains) {
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
function extractCliAgentType(agentCompose: unknown): string {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return "claude-code";
  const agents = Object.values(compose.agents);
  return agents[0]?.provider || "claude-code";
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
export async function prepareForExecution(
  context: ExecutionContext,
): Promise<PreparedContext> {
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

    // Experimental firewall configuration (processed with auto-injected rules)
    experimentalFirewall,

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
