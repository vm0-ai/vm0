import { eq } from "drizzle-orm";
import {
  getModelProviderFirewall,
  getConnectorFirewall,
  isFirewallConnectorType,
  type ConnectorType,
  type ExpandedFirewallConfig,
  type ModelProviderType,
  type FirewallPolicies,
  type Firewalls,
  type NetworkPolicies,
} from "@vm0/core";
import { zeroRuns } from "../../db/schema/zero-run";
import { badRequest, notFound } from "../shared/errors";
import { logger } from "../shared/logger";
import type { ExecutionContext, ResumeSession } from "../infra/run/types";
import type { ArtifactSnapshot } from "../infra/checkpoint/types";
import type { AdditionalVolume } from "../infra/storage/types";
import { expandEnvironmentFromCompose } from "../infra/run/environment";
import { getUserPreferences } from "./user/user-preferences-service";
import { getApiTokenConnectorTypes } from "./connector/connector-service";
import {
  MODEL_PROVIDER_ENV_VARS,
  resolveModelProviderSecrets,
} from "./context/resolve-model-provider";
import { resolveOauthConnectorSecrets } from "./context/resolve-connectors";
import { resolveCustomConnectorFirewalls } from "./custom-connector/resolve-custom-connectors";
import {
  fetchReferencedSecrets,
  filterDbSecretsByConnectorPermissions,
  fetchAndMergeVariables,
} from "./context/resolve-secrets";
import {
  filterSecretConnectorMap,
  mergePermissions,
} from "./context/resolve-permissions";
import {
  resolveSource,
  loadAgentComposeForNewRun,
  verifyOrgAccessForResume,
  resolveComposeFromId,
  checkProviderCompatibility,
  applyResolutionDefaults,
} from "./context/resolve-source";

// Re-exports for API compatibility
export { MODEL_PROVIDER_ENV_VARS } from "./context/resolve-model-provider";
export {
  filterSecretConnectorMap,
  applyConnectorPolicies,
} from "./context/resolve-permissions";

const log = logger("zero:build-context");

/**
 * Parameters for building Zero execution context.
 * Contains all fields needed to resolve secrets, model providers, connectors,
 * and build the final ExecutionContext for sandbox dispatch.
 */
interface BuildZeroContextParams {
  // Shortcuts (mutually exclusive)
  checkpointId?: string;
  sessionId?: string;
  // Base parameters
  agentComposeVersionId?: string;
  conversationId?: string;
  artifactName?: string;
  artifactVersion?: string;
  memoryName?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  additionalVolumes?: AdditionalVolume[];
  // Pre-loaded compose content — skips DB lookup in new-run path if provided
  agentCompose?: unknown;
  // Required
  prompt: string;
  appendSystemPrompt?: string;
  disallowedTools?: string[];
  tools?: string[];
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings?: string;
  runId: string;
  sandboxToken: string;
  userId: string;
  // Metadata for vm0_start event
  agentName?: string;
  resumedFromCheckpointId?: string;
  continuedFromSessionId?: string;
  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude?: boolean;
  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies?: boolean;
  // Model provider for automatic secret injection
  modelProvider?: string;
  // Per-agent or per-schedule model provider override (by provider ID + model)
  modelProviderId?: string;
  selectedModelOverride?: string;
  // API start time for E2E timing metrics
  apiStartTime?: number;
  // Per-permission policies from zero agent configuration (includes unknownPolicy).
  permissionPolicies?: FirewallPolicies;
  // Caller-resolved org context for secret/variable/storage resolution.
  orgId: string;
  // Connector types the user has permitted for this agent run. When set, only
  // these connector types will have their secrets injected at runtime.
  allowedConnectorTypes?: ConnectorType[];
  // Pre-fetched user timezone from Phase 1 — skips getUserPreferences() when provided
  preloadedUserTimezone?: string;
}

/**
 * Resolve all secrets (user, model provider, connector) and expand environment.
 */
async function resolveSecretsAndEnvironment(
  orgId: string,
  agentCompose: unknown,
  firstAgent:
    | { environment?: Record<string, string>; framework?: string }
    | undefined,
  vars: Record<string, string> | undefined,
  cliSecrets: Record<string, string> | undefined,
  modelProvider: string | undefined,
  userId: string,
  allowedConnectorTypes?: ConnectorType[],
  modelProviderId?: string,
  selectedModelOverride?: string,
): Promise<{
  secrets: Record<string, string> | undefined;
  environment: Record<string, string> | undefined;
  secretConnectorMap: Record<string, string> | undefined;
  resolvedModelProvider: ModelProviderType | undefined;
  modelProviderConfig: ExpandedFirewallConfig | undefined;
  selectedModel: string | undefined;
  connectorPermissionConfigs: ExpandedFirewallConfig[];
  mergedVars: Record<string, string> | undefined;
}> {
  // Model provider secret injection
  const hasExplicitModelProviderConfig = MODEL_PROVIDER_ENV_VARS.some((v) => {
    return firstAgent?.environment?.[v] !== undefined;
  });
  const framework = firstAgent?.framework || "claude-code";

  // Run all secret resolution and variable fetching in parallel.
  // The three resolve functions have independent DB queries (different secret types),
  // so there is no data dependency between them.
  const [
    dbSecrets,
    modelProviderResult,
    oauthResult,
    apiTokenTypes,
    mergedVars,
    customConnectorResult,
  ] = await Promise.all([
    fetchReferencedSecrets(orgId, userId, firstAgent?.environment),
    resolveModelProviderSecrets(
      orgId,
      framework,
      hasExplicitModelProviderConfig,
      modelProvider,
      modelProviderId,
      selectedModelOverride,
    ),
    resolveOauthConnectorSecrets(orgId, userId, allowedConnectorTypes),
    getApiTokenConnectorTypes(orgId, userId),
    fetchAndMergeVariables(orgId, userId, vars),
    resolveCustomConnectorFirewalls(orgId, userId),
  ]);

  const rawApiTokenTypes = allowedConnectorTypes
    ? apiTokenTypes.filter((t) => {
        return allowedConnectorTypes.includes(t);
      })
    : apiTokenTypes;

  const connectorTypes = [
    ...new Set([...oauthResult.connectorTypes, ...rawApiTokenTypes]),
  ];

  // Filter dbSecrets: strip env vars that belong to disallowed connectors.
  // Without this, api-token connector secrets (e.g. AXIOM_TOKEN) would leak
  // into the run context even when the agent doesn't have that connector enabled.
  // Custom user secrets (not owned by any connector) are never filtered.
  const filteredDbSecrets = filterDbSecretsByConnectorPermissions(
    dbSecrets,
    apiTokenTypes,
    allowedConnectorTypes,
  );

  // Single secrets map with explicit priority (later overrides earlier).
  // Only mapped env vars from connectors are included — raw connector secrets
  // (including refresh tokens) are kept server-side and never sent to the runner.
  const hasCustomConnectorSecrets =
    Object.keys(customConnectorResult.secrets).length > 0;
  const hasSecrets =
    oauthResult.resolvedSecrets ||
    modelProviderResult.secrets ||
    filteredDbSecrets ||
    cliSecrets ||
    hasCustomConnectorSecrets;
  const secrets: Record<string, string> | undefined = hasSecrets
    ? {
        ...oauthResult.resolvedSecrets, // connector env mappings (e.g. GITHUB_TOKEN)
        ...modelProviderResult.secrets, // model provider
        ...filteredDbSecrets, // DB user secrets (connector secrets filtered)
        ...customConnectorResult.secrets, // org custom connector per-user secrets
        ...cliSecrets, // highest: CLI --secrets
      }
    : undefined;

  // Filter secretConnectorMap: remove keys overridden by higher-priority sources.
  const secretConnectorMap = filterSecretConnectorMap(
    oauthResult.secretConnectorMap,
    [modelProviderResult.secrets, dbSecrets, cliSecrets],
  );

  // Auto-generate config entry for model provider (if applicable).
  // For meta-providers like "vm0", use the concrete provider type for lookup.
  const modelProviderFirewallType =
    modelProviderResult.concreteProviderType ??
    modelProviderResult.resolvedModelProvider;
  const modelProviderConfig = modelProviderFirewallType
    ? getModelProviderFirewall(modelProviderFirewallType)
    : undefined;

  // Build connector permission configs for placeholder injection and firewall
  // rules. When allowedConnectorTypes is provided, use it so that firewalls are
  // injected even when the user hasn't linked the connector yet (no secrets).
  // When undefined (no org context / CLI direct call), fall back to
  // connectorTypes (secret-derived) for backward compatibility.
  const firewallSourceTypes = allowedConnectorTypes ?? connectorTypes;
  const connectorPermissionConfigs: ExpandedFirewallConfig[] = [
    ...firewallSourceTypes.filter(isFirewallConnectorType).map((type) => {
      return {
        ...getConnectorFirewall(type),
        ref: type,
      };
    }),
    ...customConnectorResult.firewalls,
  ];

  // Expand environment variables from compose config.
  // All permission configs (model provider, connector) are passed via the
  // `firewalls` param for unified placeholder injection.
  const { environment } = expandEnvironmentFromCompose(
    agentCompose,
    mergedVars,
    secrets,
    modelProviderResult.injectedEnvironment,
    [
      ...(modelProviderConfig ? [modelProviderConfig] : []),
      ...connectorPermissionConfigs,
    ],
  );

  return {
    secrets,
    environment,
    secretConnectorMap,
    resolvedModelProvider: modelProviderResult.resolvedModelProvider,
    modelProviderConfig,
    selectedModel: modelProviderResult.selectedModel,
    connectorPermissionConfigs,
    mergedVars,
  };
}

interface BuildZeroContextTimings {
  resolveSourceAndOrg: number;
  resolveSecrets: number;
}

interface BuildZeroContextResult {
  context: ExecutionContext;
  timings: BuildZeroContextTimings;
  /** The resolved model provider type, if provider resolution ran during context build. */
  resolvedModelProvider: ModelProviderType | undefined;
  /** The logical model name selected by the user, for credit usage billing. */
  selectedModel: string | undefined;
}

/**
 * Parameters for CLI run context resolution.
 */
interface ResolveCliRunContextParams {
  orgId: string;
  userId: string;
  // Compose resolution shortcuts (mutually exclusive)
  sessionId?: string;
  checkpointId?: string;
  conversationId?: string;
  composeId?: string;
  agentComposeVersionId?: string;
  // Pre-loaded compose content — skips DB lookup if provided
  agentCompose?: unknown;
  // Caller-provided data
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  modelProvider?: string;
  permissionPolicies?: FirewallPolicies;
  allowedConnectorTypes?: ConnectorType[];
  // Artifact/memory
  artifactName?: string;
  artifactVersion?: string;
  memoryName?: string;
  volumeVersions?: Record<string, string>;
  // Model provider selection
  modelProviderId?: string;
  selectedModelOverride?: string;
}

/**
 * Pre-resolved context data for CLI runs.
 * Returned by resolveCliRunContext() for the CLI route to use inline.
 */
interface ResolvedCliContext {
  // Session/checkpoint resolution
  agentComposeVersionId?: string;
  agentCompose?: unknown;
  artifactName?: string;
  artifactVersion?: string;
  memoryName?: string;
  vars?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  additionalVolumes?: AdditionalVolume[];
  resumeSession?: ResumeSession;
  resumeArtifact?: ArtifactSnapshot;

  // Secrets/environment resolution
  secrets?: Record<string, string>;
  environment?: Record<string, string>;
  secretConnectorMap?: Record<string, string>;
  firewalls?: Firewalls;
  networkPolicies?: NetworkPolicies;
  userTimezone?: string;

  // Model provider metadata (for zero_runs upsert)
  resolvedModelProvider?: ModelProviderType;
  selectedModel?: string;

  // Timings
  timings: {
    resolveSource: number;
    resolveSecrets: number;
  };
}

/**
 * Resolve all zero-layer data for CLI runs.
 *
 * This is the CLI counterpart to buildZeroExecutionContext — it performs the
 * same resolution (vars, secrets, connectors, permissions, timezone, model
 * provider) but returns pre-resolved data instead of a built ExecutionContext.
 * The CLI route calls this to get resolved context, then directly uses
 * buildInfraExecutionContext to assemble the context.
 */
export async function resolveCliRunContext(
  params: ResolveCliRunContextParams,
): Promise<ResolvedCliContext> {
  log.debug(`Resolving CLI run context for org ${params.orgId}`);

  // Validate mutual exclusivity (same check as resolveStartRunCompose)
  if (params.checkpointId && params.sessionId) {
    throw badRequest(
      "Cannot specify both checkpointId and sessionId. Use one or the other.",
    );
  }

  // Org access pre-check: verify the compose belongs to the caller's org
  // BEFORE full resolution. This prevents leaking session/checkpoint details
  // (e.g., framework mismatch errors) for cross-org access attempts.
  await verifyOrgAccessForResume(params);

  // Initialize context variables
  let agentComposeVersionId: string | undefined = params.agentComposeVersionId;
  let agentCompose: unknown;
  let artifactName: string | undefined = params.artifactName;
  let artifactVersion: string | undefined = params.artifactVersion;
  let vars: Record<string, string> | undefined = params.vars;
  let memoryName: string | undefined = params.memoryName;
  let volumeVersions: Record<string, string> | undefined =
    params.volumeVersions;
  let additionalVolumes: AdditionalVolume[] | undefined;
  let resumeSession: ResumeSession | undefined;
  let resumeArtifact: ArtifactSnapshot | undefined;

  // Step 1: Resolve source (checkpoint/session/conversation).
  const resolveStart = Date.now();
  const resolution = await resolveSource(params);
  const resolveEnd = Date.now();

  // Step 2: Apply resolution defaults
  if (resolution) {
    const defaults = applyResolutionDefaults(params, resolution);
    agentComposeVersionId = defaults.agentComposeVersionId;
    agentCompose = defaults.agentCompose;
    artifactName = defaults.artifactName;
    artifactVersion = defaults.artifactVersion;
    memoryName = defaults.memoryName;
    vars = defaults.vars;
    volumeVersions = defaults.volumeVersions;
    additionalVolumes = defaults.additionalVolumes;
    resumeSession = defaults.resumeSession;
    resumeArtifact = defaults.resumeArtifact;
  }
  // Step 3: New run — resolve compose from composeId or agentComposeVersionId
  else if (!agentComposeVersionId && params.composeId) {
    agentComposeVersionId = await resolveComposeFromId(
      params.composeId,
      params.orgId,
    );
  }

  // Load compose content if we have a version ID
  if (!agentCompose && agentComposeVersionId) {
    agentCompose =
      params.agentCompose ??
      (await loadAgentComposeForNewRun(agentComposeVersionId));
  }

  if (!agentCompose) {
    // No compose available — return only what we can resolve
    return {
      vars,
      timings: {
        resolveSource: resolveEnd - resolveStart,
        resolveSecrets: 0,
      },
    };
  }

  // Extract compose structure for secret resolution
  const compose = agentCompose as {
    agents?: Record<
      string,
      { environment?: Record<string, string>; framework?: string }
    >;
  };
  const firstAgent = compose?.agents
    ? Object.values(compose.agents)[0]
    : undefined;

  // Step 4: Resolve secrets, user preferences in parallel.
  const resolveSecretsStart = Date.now();
  const [secretsResult, userPrefs, originalModelProvider] = await Promise.all([
    resolveSecretsAndEnvironment(
      params.orgId,
      agentCompose,
      firstAgent,
      vars,
      params.secrets,
      params.modelProvider,
      params.userId,
      params.allowedConnectorTypes,
      params.modelProviderId,
      params.selectedModelOverride,
    ),
    getUserPreferences(params.orgId, params.userId),
    // Fetch previous run's model provider for compatibility check
    resolution?.previousRunId
      ? globalThis.services.db
          .select({ modelProvider: zeroRuns.modelProvider })
          .from(zeroRuns)
          .where(eq(zeroRuns.id, resolution.previousRunId))
          .limit(1)
          .then(([row]) => {
            return row?.modelProvider ?? undefined;
          })
      : Promise.resolve(undefined),
  ]);
  const resolveSecretsEnd = Date.now();

  const {
    secrets,
    environment,
    secretConnectorMap,
    resolvedModelProvider,
    modelProviderConfig,
    selectedModel,
    connectorPermissionConfigs,
    mergedVars,
  } = secretsResult;
  const userTimezone = userPrefs?.timezone ?? undefined;

  // Step 5: Provider compatibility check for session continues.
  checkProviderCompatibility(originalModelProvider, resolvedModelProvider);

  // Build permission manifest
  const permissionResult = mergePermissions(
    modelProviderConfig,
    connectorPermissionConfigs,
    params.permissionPolicies,
    mergedVars,
  );

  return {
    agentComposeVersionId,
    agentCompose,
    artifactName,
    artifactVersion,
    memoryName,
    vars: mergedVars ?? vars,
    volumeVersions,
    additionalVolumes,
    resumeSession,
    resumeArtifact,
    secrets,
    environment,
    secretConnectorMap,
    firewalls: permissionResult?.firewalls,
    networkPolicies: permissionResult?.networkPolicies,
    userTimezone,
    resolvedModelProvider,
    selectedModel,
    timings: {
      resolveSource: resolveEnd - resolveStart,
      resolveSecrets: resolveSecretsEnd - resolveSecretsStart,
    },
  };
}

/**
 * Build Zero execution context from various parameter sources.
 * Handles: new run, checkpoint resume, session continue.
 *
 * This is the Zero layer's context builder — it resolves all business data
 * (model providers, secrets, connectors, variables, user preferences, permissions)
 * and builds the final ExecutionContext for sandbox dispatch.
 *
 * Parameter expansion:
 * - checkpointId: Expands to checkpoint snapshot (config, conversation, artifact, volumes)
 * - sessionId: Expands to session data (config, conversation, artifact=latest)
 * - Explicit parameters override expanded values
 */
export async function buildZeroExecutionContext(
  params: BuildZeroContextParams,
): Promise<BuildZeroContextResult> {
  log.debug(`Building zero execution context for ${params.runId}`);
  log.debug(`params.volumeVersions=${JSON.stringify(params.volumeVersions)}`);

  // Initialize context variables
  let agentComposeVersionId: string | undefined = params.agentComposeVersionId;
  let agentCompose: unknown;
  let artifactName: string | undefined = params.artifactName;
  let artifactVersion: string | undefined = params.artifactVersion;
  let vars: Record<string, string> | undefined = params.vars;
  let memoryName: string | undefined = params.memoryName;
  let volumeVersions: Record<string, string> | undefined =
    params.volumeVersions;
  let additionalVolumes: AdditionalVolume[] | undefined =
    params.additionalVolumes;
  let resumeSession: ResumeSession | undefined;
  let resumeArtifact: ArtifactSnapshot | undefined;

  // Step 1: Resolve source (checkpoint/session/conversation).
  const resolveStart = Date.now();
  const resolution = await resolveSource(params);
  const resolveEnd = Date.now();

  // Step 2: Apply resolution defaults and build resumeSession (unified path)
  // Note: secrets are NEVER stored - caller must always provide fresh secrets via params
  if (resolution) {
    const defaults = applyResolutionDefaults(params, resolution);
    agentComposeVersionId = defaults.agentComposeVersionId;
    agentCompose = defaults.agentCompose;
    artifactName = defaults.artifactName;
    artifactVersion = defaults.artifactVersion;
    memoryName = defaults.memoryName;
    vars = defaults.vars;
    volumeVersions = defaults.volumeVersions;
    additionalVolumes = params.additionalVolumes || defaults.additionalVolumes;
    resumeSession = defaults.resumeSession;
    resumeArtifact = defaults.resumeArtifact;

    log.debug(
      `Resolution applied: artifact=${artifactName}@${artifactVersion}`,
    );
  }
  // Step 3: New run - use pre-loaded compose or load from DB
  else if (agentComposeVersionId) {
    agentCompose =
      params.agentCompose ??
      (await loadAgentComposeForNewRun(agentComposeVersionId));
  }

  // Validate required fields
  if (!agentComposeVersionId) {
    throw notFound(
      "Agent compose version ID is required (provide agentComposeVersionId, checkpointId, or sessionId)",
    );
  }

  if (!agentCompose) {
    throw notFound("Agent compose could not be loaded");
  }

  // Extract compose structure
  const compose = agentCompose as {
    agents?: Record<
      string,
      { environment?: Record<string, string>; framework?: string }
    >;
  };
  const firstAgent = compose?.agents
    ? Object.values(compose.agents)[0]
    : undefined;

  // Step 4: Resolve secrets, user preferences in parallel.
  // When preloadedUserTimezone is provided (from Phase 1), skip getUserPreferences
  // to avoid the duplicate DB query.
  const resolveSecretsStart = Date.now();
  const [secretsResult, userPrefs, originalModelProvider] = await Promise.all([
    resolveSecretsAndEnvironment(
      params.orgId,
      agentCompose,
      firstAgent,
      vars,
      params.secrets,
      params.modelProvider,
      params.userId,
      params.allowedConnectorTypes,
      params.modelProviderId,
      params.selectedModelOverride,
    ),
    params.preloadedUserTimezone !== undefined
      ? Promise.resolve(null)
      : params.userId
        ? getUserPreferences(params.orgId, params.userId)
        : Promise.resolve(null),
    // Zero-layer concern: fetch previous run's model provider for compatibility check
    resolution?.previousRunId
      ? globalThis.services.db
          .select({ modelProvider: zeroRuns.modelProvider })
          .from(zeroRuns)
          .where(eq(zeroRuns.id, resolution.previousRunId))
          .limit(1)
          .then(([row]) => {
            return row?.modelProvider ?? undefined;
          })
      : Promise.resolve(undefined),
  ]);
  const resolveSecretsEnd = Date.now();

  const {
    secrets,
    environment,
    secretConnectorMap,
    resolvedModelProvider,
    modelProviderConfig,
    selectedModel,
    connectorPermissionConfigs,
    mergedVars,
  } = secretsResult;
  const userTimezone =
    params.preloadedUserTimezone ?? userPrefs?.timezone ?? undefined;

  // Step 5: Provider compatibility check for session continues.
  // When resuming a session, verify the new provider is compatible with the
  // original provider to avoid mid-conversation base URL mismatches.
  checkProviderCompatibility(originalModelProvider, resolvedModelProvider);

  // Build permission manifest (base + auth entries for the runner).
  const permissionResult = mergePermissions(
    modelProviderConfig,
    connectorPermissionConfigs,
    params.permissionPolicies,
    mergedVars,
  );

  // Build final execution context
  return {
    context: {
      runId: params.runId,
      userId: params.userId,
      orgId: params.orgId,
      agentComposeVersionId,
      agentCompose,
      prompt: params.prompt,
      appendSystemPrompt: params.appendSystemPrompt,
      vars,
      secrets,
      secretConnectorMap,
      sandboxToken: params.sandboxToken,
      artifactName,
      artifactVersion,
      memoryName,
      volumeVersions,
      additionalVolumes,
      environment,
      userTimezone,
      firewalls: permissionResult?.firewalls,
      networkPolicies: permissionResult?.networkPolicies,
      disallowedTools: params.disallowedTools,
      tools: params.tools,
      settings: params.settings,
      resumeSession,
      resumeArtifact,
      // Metadata for vm0_start event
      agentName: params.agentName,
      resumedFromCheckpointId: params.resumedFromCheckpointId,
      continuedFromSessionId: params.continuedFromSessionId,
      // Debug flag
      debugNoMockClaude: params.debugNoMockClaude,
      captureNetworkBodies: params.captureNetworkBodies,
      // API start time for E2E timing metrics
      apiStartTime: params.apiStartTime,
    },
    timings: {
      resolveSourceAndOrg: resolveEnd - resolveStart,
      resolveSecrets: resolveSecretsEnd - resolveSecretsStart,
    },
    resolvedModelProvider,
    selectedModel,
  };
}
