import { eq } from "drizzle-orm";
import {
  BILLABLE_CONNECTORS,
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type {
  ExpandedFirewallConfig,
  FirewallPolicies,
  Firewalls,
  NetworkPolicies,
} from "@vm0/connectors/firewall-types";
import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import type { SecretConnectorMetadata } from "@vm0/api-contracts/contracts/runners";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { badRequest, notFound } from "@vm0/api-services/errors";
import { logger } from "../shared/logger";
import type {
  ContextArtifact,
  DispatchDiagnosticSpan,
  ExecutionContext,
  ResumeSession,
} from "../infra/run/types";
import type { ConversationResolution } from "../infra/run/resolvers";
import type { AdditionalVolume } from "../infra/storage/types";
import { AUTO_MEMORY_ARTIFACT_NAME, AUTO_MEMORY_MOUNT_PATH } from "./memory";
import { expandEnvironmentFromCompose } from "../infra/run/environment";
import { getUserPreferences } from "./user/user-preferences-service";
import { getApiTokenConnectorTypes } from "./connector/connector-service";
import {
  MODEL_PROVIDER_ENV_VARS,
  type ResolveModelProviderSecretTimings,
  resolveModelProviderSecrets,
} from "./context/resolve-model-provider";
import { resolveOauthConnectorSecrets } from "./context/resolve-connectors";
import { resolveCustomConnectorFirewalls } from "./custom-connector/resolve-custom-connectors";
import {
  fetchReferencedSecrets,
  filterDbSecretsByConnectorPermissions,
  fetchAndMergeVariables,
  injectPlatformEnvSecrets,
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
  checkFrameworkCompatibility,
  applyResolutionDefaults,
} from "./context/resolve-source";

// Re-exports for API compatibility
export {
  filterSecretConnectorMap,
  applyConnectorPolicies,
} from "./context/resolve-permissions";

const log = logger("zero:build-context");

async function captureDuration<T>(
  operation: () => Promise<T>,
): Promise<{ value: T; durationMs: number }> {
  const start = Date.now();
  const value = await operation();
  return { value, durationMs: Date.now() - start };
}

/**
 * Append the auto-memory artifact when this is a new run. On resume paths
 * (checkpoint, session, conversation continue) the resolver already emitted
 * memory at AUTO_MEMORY_MOUNT_PATH in resolution.artifacts — re-injecting here
 * would risk shadowing a divergent user-declared artifact named "memory".
 * When the resolution has no memory entry (very old data that predates
 * memory-as-artifact) we log and skip rather than silently mount over a path
 * the user may have declared for a different purpose.
 */
/**
 * Merge multiple secretConnectorMap fragments. Used to combine the
 * connector-typed map (post-filter) with the model-provider-derived map
 * (which bypasses the filter — model-provider secrets ARE the source).
 */
function mergeSecretConnectorMaps(
  ...maps: (Record<string, string> | undefined)[]
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const m of maps) {
    if (m) Object.assign(merged, m);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeSecretConnectorMetadataMaps(
  ...maps: (Record<string, SecretConnectorMetadata> | undefined)[]
): Record<string, SecretConnectorMetadata> | undefined {
  const merged: Record<string, SecretConnectorMetadata> = {};
  for (const m of maps) {
    if (m) Object.assign(merged, m);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function injectAutoMemoryArtifactIfNewRun(
  artifacts: ContextArtifact[],
  resolution: ConversationResolution | null,
  logContext: Record<string, string>,
): ContextArtifact[] {
  if (resolution === null) {
    return [
      ...artifacts,
      { name: AUTO_MEMORY_ARTIFACT_NAME, mountPath: AUTO_MEMORY_MOUNT_PATH },
    ];
  }
  const hasMemory = artifacts.some((a) => {
    return a.name === AUTO_MEMORY_ARTIFACT_NAME;
  });
  if (!hasMemory) {
    log.warn(
      "Resume resolution has no memory artifact — skipping auto-injection",
      logContext,
    );
  }
  return artifacts;
}

function withRuntimeRunEnvironment(
  environment: Record<string, string> | undefined,
  triggerSource: string | undefined,
): Record<string, string> | undefined {
  if (!triggerSource) return environment;
  return {
    ...(environment ?? {}),
    VM0_RUN_SOURCE: triggerSource,
  };
}

interface ResolveSecretsAndEnvironmentTimings {
  fetchReferencedSecrets: number;
  resolveModelProvider: number;
  resolveOauthConnectors: number;
  getApiTokenConnectorTypes: number;
  fetchAndMergeVariables: number;
  resolveCustomConnectors: number;
  filterSecretsAndMaps: number;
  buildFirewallConfigs: number;
  expandEnvironment: number;
  billableFirewalls: number;
  modelProvider?: ResolveModelProviderSecretTimings;
}

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
  artifacts?: ContextArtifact[];
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
  // Debug flag to force real Codex in mock environments (internal use only)
  debugNoMockCodex?: boolean;
  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies?: boolean;
  // Model provider for automatic secret injection
  modelProvider?: string;
  // Per-agent or per-schedule model provider override (by provider ID + model)
  modelProviderId?: string;
  selectedModelOverride?: string;
  /**
   * Personal-tier preference (Epic #11868). Threaded into the resolver so
   * runs that resolve through agents/schedules with the flag set consult
   * user-tier providers before the org default. Honored only when the
   * `personalModelProvider` feature switch is on for the caller.
   */
  preferPersonalProvider?: boolean;
  // API start time for E2E timing metrics
  apiStartTime: number;
  // Per-permission policies from zero agent configuration (includes unknownPolicy).
  permissionPolicies?: FirewallPolicies;
  // Caller-resolved org context for secret/variable/storage resolution.
  orgId: string;
  // Connector types the user has permitted for this agent run. When set, only
  // these connector types will have their secrets injected at runtime.
  allowedConnectorTypes?: ConnectorType[];
  // Custom connector ids the user has authorized for this agent run. `undefined`
  // preserves the non-agent behavior (every connector the user has a secret
  // for). An empty array means the agent is not authorized for any custom
  // connector even if the user has set secrets.
  allowedCustomConnectorIds?: string[];
  // Pre-fetched user timezone from Phase 1 — skips getUserPreferences() when provided
  preloadedUserTimezone?: string;
  // Origin of the run request, injected into the sandbox as VM0_RUN_SOURCE.
  triggerSource?: string;
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
  allowedCustomConnectorIds?: string[],
  modelProviderId?: string,
  selectedModelOverride?: string,
  preferPersonalProvider?: boolean,
): Promise<{
  secrets: Record<string, string> | undefined;
  environment: Record<string, string> | undefined;
  secretConnectorMap: Record<string, string> | undefined;
  secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  resolvedModelProvider: ModelProviderType | undefined;
  resolvedFramework: string;
  modelProviderConfig: ExpandedFirewallConfig | undefined;
  selectedModel: string | undefined;
  connectorPermissionConfigs: ExpandedFirewallConfig[];
  mergedVars: Record<string, string> | undefined;
  billableFirewalls: string[];
  modelUsageProvider: string | undefined;
  timings: ResolveSecretsAndEnvironmentTimings;
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
    dbSecretsResult,
    modelProviderResult,
    oauthResult,
    apiTokenTypesResult,
    mergedVarsResult,
    customConnectorResult,
  ] = await Promise.all([
    captureDuration(() => {
      return fetchReferencedSecrets(orgId, userId, firstAgent?.environment);
    }),
    captureDuration(() => {
      return resolveModelProviderSecrets(
        orgId,
        userId,
        framework,
        hasExplicitModelProviderConfig,
        modelProvider,
        modelProviderId,
        selectedModelOverride,
        preferPersonalProvider,
      );
    }),
    captureDuration(() => {
      return resolveOauthConnectorSecrets(orgId, userId, allowedConnectorTypes);
    }),
    captureDuration(() => {
      return getApiTokenConnectorTypes(orgId, userId);
    }),
    captureDuration(() => {
      return fetchAndMergeVariables(orgId, userId, vars);
    }),
    captureDuration(() => {
      return resolveCustomConnectorFirewalls(
        orgId,
        userId,
        allowedCustomConnectorIds,
      );
    }),
  ]);
  const dbSecrets = dbSecretsResult.value;
  const resolvedModelProviderResult = modelProviderResult.value;
  const oauthConnectors = oauthResult.value;
  const apiTokenTypes = apiTokenTypesResult.value;
  const mergedVars = mergedVarsResult.value;
  const customConnectors = customConnectorResult.value;
  const timings: ResolveSecretsAndEnvironmentTimings = {
    fetchReferencedSecrets: dbSecretsResult.durationMs,
    resolveModelProvider: modelProviderResult.durationMs,
    resolveOauthConnectors: oauthResult.durationMs,
    getApiTokenConnectorTypes: apiTokenTypesResult.durationMs,
    fetchAndMergeVariables: mergedVarsResult.durationMs,
    resolveCustomConnectors: customConnectorResult.durationMs,
    filterSecretsAndMaps: 0,
    buildFirewallConfigs: 0,
    expandEnvironment: 0,
    billableFirewalls: 0,
    modelProvider: resolvedModelProviderResult.timings,
  };

  const filterSecretsStart = Date.now();
  const rawApiTokenTypes = allowedConnectorTypes
    ? apiTokenTypes.filter((t) => {
        return allowedConnectorTypes.includes(t);
      })
    : apiTokenTypes;

  const connectorTypes = [
    ...new Set([...oauthConnectors.connectorTypes, ...rawApiTokenTypes]),
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
  // Platform env secrets (1Password → CI → process.env) for firewall templates.
  // Injected only for connector contexts that need them. Platform env secrets
  // override DB/custom values; CLI secrets still win.
  const envSecrets = injectPlatformEnvSecrets(connectorTypes);

  const hasCustomConnectorSecrets =
    Object.keys(customConnectors.secrets).length > 0;
  const hasSecrets =
    oauthConnectors.resolvedSecrets ||
    resolvedModelProviderResult.secrets ||
    filteredDbSecrets ||
    cliSecrets ||
    hasCustomConnectorSecrets ||
    envSecrets;
  const secrets: Record<string, string> | undefined = hasSecrets
    ? {
        ...oauthConnectors.resolvedSecrets, // connector env mappings (e.g. GITHUB_TOKEN)
        ...resolvedModelProviderResult.secrets, // model provider
        ...filteredDbSecrets, // DB user secrets (connector secrets filtered)
        ...customConnectors.secrets, // org custom connector per-user secrets
        ...envSecrets, // platform env secrets (e.g. GOOGLE_ADS_DEVELOPER_TOKEN)
        ...cliSecrets, // highest: CLI --secrets
      }
    : undefined;

  // Filter secretConnectorMap: remove keys overridden by higher-priority sources.
  // Then merge in model-provider-derived entries (CHATGPT_ACCESS_TOKEN → "codex-oauth"
  // for codex-oauth-token providers). Model-provider entries are added AFTER the
  // filter because they share names with `modelProviderResult.secrets` — those secrets
  // ARE the source of the OAuth refresh, not an override target.
  const filteredOauthMap = filterSecretConnectorMap(
    oauthConnectors.secretConnectorMap,
    [resolvedModelProviderResult.secrets, dbSecrets, cliSecrets],
  );
  const secretConnectorMap = mergeSecretConnectorMaps(
    filteredOauthMap,
    resolvedModelProviderResult.secretConnectorMap,
  );
  const secretConnectorMetadataMap = mergeSecretConnectorMetadataMaps(
    resolvedModelProviderResult.secretConnectorMetadataMap,
  );
  timings.filterSecretsAndMaps = Date.now() - filterSecretsStart;

  const buildFirewallConfigsStart = Date.now();
  // Auto-generate config entry for model provider (if applicable).
  // For meta-providers like "vm0", use the concrete provider type for lookup.
  const modelProviderFirewallType =
    resolvedModelProviderResult.concreteProviderType ??
    resolvedModelProviderResult.resolvedModelProvider;
  const modelProviderConfig = modelProviderFirewallType
    ? getModelProviderFirewall(modelProviderFirewallType)
    : undefined;

  // Build connector permission configs for placeholder injection and firewall
  // rules. Product policy: a connector is usable only when BOTH the agent
  // authorizes it AND the user has linked the credentials. `connectorTypes`
  // already reflects that intersection — OAuth connectors filtered by
  // allowedConnectorTypes, api-token connectors filtered by allowedConnectorTypes
  // and gated on every required secret/variable being present
  // (`deriveApiTokenConnectedTypes`). Loosening that gate silently reintroduces
  // the "Firewall base URL requires variable X but it was not provided" crash
  // when the user authorized a connector but never set its vars (e.g. Jira's
  // `https://${{ vars.JIRA_DOMAIN }}`).
  const connectorPermissionConfigs: ExpandedFirewallConfig[] = [
    ...connectorTypes.filter(isFirewallConnectorType).map((type) => {
      return { ...getConnectorFirewall(type) };
    }),
    ...customConnectors.firewalls,
  ];
  timings.buildFirewallConfigs = Date.now() - buildFirewallConfigsStart;

  const expandEnvironmentStart = Date.now();
  // Expand environment variables from compose config.
  // All permission configs (model provider, connector) are passed via the
  // `firewalls` param for unified placeholder injection.
  const { environment } = expandEnvironmentFromCompose(
    agentCompose,
    mergedVars,
    secrets,
    resolvedModelProviderResult.injectedEnvironment,
    [
      ...(modelProviderConfig ? [modelProviderConfig] : []),
      ...connectorPermissionConfigs,
    ],
  );
  timings.expandEnvironment = Date.now() - expandEnvironmentStart;

  const billableFirewallsStart = Date.now();
  // Billable firewalls feed flow.metadata["firewall_billable"] in mitm-addon,
  // gating platform-side billing webhooks and full-body response buffering:
  // - vm0 meta-provider: platform-paid model tokens (user didn't supply a key).
  // - Connector firewalls listed in BILLABLE_CONNECTORS: per-call priced APIs
  //   where the platform covers the upstream cost and bills the user.
  const billableFirewalls: string[] = [];
  const vm0ManagedModelProviderConfig =
    resolvedModelProviderResult.resolvedModelProvider === "vm0" &&
    modelProviderConfig;
  if (vm0ManagedModelProviderConfig) {
    billableFirewalls.push(vm0ManagedModelProviderConfig.name);
  }
  const modelUsageProvider = vm0ManagedModelProviderConfig
    ? resolvedModelProviderResult.selectedModel
    : undefined;
  const billableConnectorSet = new Set<string>(BILLABLE_CONNECTORS);
  for (const fw of connectorPermissionConfigs) {
    if (billableConnectorSet.has(fw.name)) {
      billableFirewalls.push(fw.name);
    }
  }
  timings.billableFirewalls = Date.now() - billableFirewallsStart;

  return {
    secrets,
    environment,
    secretConnectorMap,
    secretConnectorMetadataMap,
    resolvedModelProvider: resolvedModelProviderResult.resolvedModelProvider,
    // Provider-derived framework when resolution ran; otherwise the compose
    // framework. Source-of-truth for downstream framework-aware logic.
    resolvedFramework: resolvedModelProviderResult.framework ?? framework,
    modelProviderConfig,
    selectedModel: resolvedModelProviderResult.selectedModel,
    connectorPermissionConfigs,
    mergedVars,
    billableFirewalls,
    modelUsageProvider,
    timings,
  };
}

interface BuildZeroContextTimings {
  resolveSourceAndOrg: number;
  resolveSecrets: number;
  userPreferences: number;
  previousRunModelProvider: number;
  compatibilityChecks: number;
  mergePermissions: number;
  resolveSecretsDetails: ResolveSecretsAndEnvironmentTimings;
  diagnosticSpans: DispatchDiagnosticSpan[];
}

interface BuildZeroContextResult {
  context: ExecutionContext;
  timings: BuildZeroContextTimings;
  /** The resolved model provider type, if provider resolution ran during context build. */
  resolvedModelProvider: ModelProviderType | undefined;
  /** Provider-derived framework, source-of-truth for downstream. */
  resolvedFramework: string;
  /** The logical model name selected by the user, for model usage billing. */
  selectedModel: string | undefined;
}

function optionalDiagnosticSpan(
  op: string,
  ms: number | undefined,
): DispatchDiagnosticSpan[] {
  return ms === undefined ? [] : [{ op, ms }];
}

function buildDiagnosticSpans(
  timings: Omit<BuildZeroContextTimings, "diagnosticSpans">,
): DispatchDiagnosticSpan[] {
  const modelProvider = timings.resolveSecretsDetails.modelProvider;
  return [
    {
      op: "api_build_resolve_secrets_fetch_secrets",
      ms: timings.resolveSecretsDetails.fetchReferencedSecrets,
    },
    {
      op: "api_build_resolve_secrets_model_provider",
      ms: timings.resolveSecretsDetails.resolveModelProvider,
    },
    {
      op: "api_build_resolve_secrets_oauth_connectors",
      ms: timings.resolveSecretsDetails.resolveOauthConnectors,
    },
    {
      op: "api_build_resolve_secrets_api_token_types",
      ms: timings.resolveSecretsDetails.getApiTokenConnectorTypes,
    },
    {
      op: "api_build_resolve_secrets_variables",
      ms: timings.resolveSecretsDetails.fetchAndMergeVariables,
    },
    {
      op: "api_build_resolve_secrets_custom_connectors",
      ms: timings.resolveSecretsDetails.resolveCustomConnectors,
    },
    {
      op: "api_build_resolve_secrets_maps",
      ms: timings.resolveSecretsDetails.filterSecretsAndMaps,
    },
    {
      op: "api_build_resolve_secrets_firewall_configs",
      ms: timings.resolveSecretsDetails.buildFirewallConfigs,
    },
    {
      op: "api_build_resolve_secrets_expand_environment",
      ms: timings.resolveSecretsDetails.expandEnvironment,
    },
    {
      op: "api_build_resolve_secrets_billable_firewalls",
      ms: timings.resolveSecretsDetails.billableFirewalls,
    },
    { op: "api_build_user_preferences", ms: timings.userPreferences },
    {
      op: "api_build_previous_model_provider",
      ms: timings.previousRunModelProvider,
    },
    {
      op: "api_build_compatibility_checks",
      ms: timings.compatibilityChecks,
    },
    { op: "api_build_merge_permissions", ms: timings.mergePermissions },
    ...optionalDiagnosticSpan(
      "api_build_model_provider_personal_eligibility",
      modelProvider?.personalEligibility,
    ),
    ...optionalDiagnosticSpan(
      "api_build_model_provider_default_lookup",
      modelProvider?.defaultProviderLookup,
    ),
    ...optionalDiagnosticSpan(
      "api_build_model_provider_matching_lookup",
      modelProvider?.matchingProviderLookup,
    ),
    ...optionalDiagnosticSpan(
      "api_build_model_provider_vm0_resolution",
      modelProvider?.vm0ProviderResolution,
    ),
    ...optionalDiagnosticSpan(
      "api_build_model_provider_multi_auth_resolution",
      modelProvider?.multiAuthSecretResolution,
    ),
    ...optionalDiagnosticSpan(
      "api_build_model_provider_single_secret_fetch",
      modelProvider?.singleSecretFetch,
    ),
    ...optionalDiagnosticSpan(
      "api_build_model_provider_environment_mapping",
      modelProvider?.environmentMapping,
    ),
  ];
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
  allowedCustomConnectorIds?: string[];
  volumeVersions?: Record<string, string>;
  // Model provider selection
  modelProviderId?: string;
  selectedModelOverride?: string;
  /**
   * Personal-tier preference (Epic #11868). Mirrors `BuildZeroContextParams`
   * — see that interface for full semantics.
   */
  preferPersonalProvider?: boolean;
}

/**
 * Pre-resolved context data for CLI runs.
 * Returned by resolveCliRunContext() for the CLI route to use inline.
 */
interface ResolvedCliContext {
  // Session/checkpoint resolution
  agentComposeVersionId?: string;
  agentCompose?: unknown;
  artifacts: ContextArtifact[];
  vars?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  additionalVolumes?: AdditionalVolume[];
  resumeSession?: ResumeSession;

  // Secrets/environment resolution
  secrets?: Record<string, string>;
  environment?: Record<string, string>;
  secretConnectorMap?: Record<string, string>;
  secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
  firewalls?: Firewalls;
  networkPolicies?: NetworkPolicies;
  userTimezone?: string;

  // Model provider metadata (for zero_runs upsert)
  resolvedModelProvider?: ModelProviderType;
  selectedModel?: string;

  billableFirewalls: string[];
  modelUsageProvider?: string;

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
  let artifacts: ContextArtifact[] = [];
  let vars: Record<string, string> | undefined = params.vars;
  let volumeVersions: Record<string, string> | undefined =
    params.volumeVersions;
  let additionalVolumes: AdditionalVolume[] | undefined;
  let resumeSession: ResumeSession | undefined;

  // Step 1: Resolve source (checkpoint/session/conversation).
  const resolveStart = Date.now();
  const resolution = await resolveSource(params);
  const resolveEnd = Date.now();

  // Step 2: Apply resolution defaults
  if (resolution) {
    const defaults = applyResolutionDefaults(params, resolution);
    agentComposeVersionId = defaults.agentComposeVersionId;
    agentCompose = defaults.agentCompose;
    artifacts = defaults.artifacts;
    vars = defaults.vars;
    volumeVersions = defaults.volumeVersions;
    additionalVolumes = defaults.additionalVolumes;
    resumeSession = defaults.resumeSession;
  }
  // Step 3: New run — resolve compose from composeId or agentComposeVersionId
  else if (!agentComposeVersionId && params.composeId) {
    agentComposeVersionId = await resolveComposeFromId(
      params.composeId,
      params.orgId,
    );
  }

  // Memory injection — see injectAutoMemoryArtifactIfNewRun().
  artifacts = injectAutoMemoryArtifactIfNewRun(artifacts, resolution, {
    userId: params.userId,
    orgId: params.orgId,
  });

  // Load compose content if we have a version ID
  if (!agentCompose && agentComposeVersionId) {
    agentCompose =
      params.agentCompose ??
      (await loadAgentComposeForNewRun(agentComposeVersionId));
  }

  if (!agentCompose) {
    // No compose available — return only what we can resolve
    return {
      artifacts,
      vars,
      billableFirewalls: [],
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
      params.allowedCustomConnectorIds,
      params.modelProviderId,
      params.selectedModelOverride,
      params.preferPersonalProvider,
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
    secretConnectorMetadataMap,
    resolvedModelProvider,
    resolvedFramework,
    modelProviderConfig,
    selectedModel,
    connectorPermissionConfigs,
    mergedVars,
    billableFirewalls,
    modelUsageProvider,
  } = secretsResult;
  const userTimezone = userPrefs?.timezone ?? undefined;

  // Step 5: Compatibility checks for session continues.
  checkProviderCompatibility(originalModelProvider, resolvedModelProvider);
  checkFrameworkCompatibility(resolution?.sessionFramework, resolvedFramework);

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
    artifacts,
    vars: mergedVars ?? vars,
    volumeVersions,
    additionalVolumes,
    resumeSession,
    secrets,
    environment,
    secretConnectorMap,
    secretConnectorMetadataMap,
    firewalls: permissionResult?.firewalls,
    networkPolicies: permissionResult?.networkPolicies,
    userTimezone,
    resolvedModelProvider,
    selectedModel,
    billableFirewalls,
    modelUsageProvider,
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
  let artifacts: ContextArtifact[] = params.artifacts ?? [];
  let vars: Record<string, string> | undefined = params.vars;
  let volumeVersions: Record<string, string> | undefined =
    params.volumeVersions;
  let additionalVolumes: AdditionalVolume[] | undefined =
    params.additionalVolumes;
  let resumeSession: ResumeSession | undefined;

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
    artifacts = defaults.artifacts;
    vars = defaults.vars;
    volumeVersions = defaults.volumeVersions;
    additionalVolumes = params.additionalVolumes || defaults.additionalVolumes;
    resumeSession = defaults.resumeSession;

    log.debug(`Resolution applied: artifacts=${JSON.stringify(artifacts)}`);
  }
  // Step 3: New run - use pre-loaded compose or load from DB
  else if (agentComposeVersionId) {
    agentCompose =
      params.agentCompose ??
      (await loadAgentComposeForNewRun(agentComposeVersionId));
  }

  // Memory injection — see injectAutoMemoryArtifactIfNewRun().
  artifacts = injectAutoMemoryArtifactIfNewRun(artifacts, resolution, {
    runId: params.runId,
  });

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
  const [secretsResultTimed, userPrefsTimed, originalModelProviderTimed] =
    await Promise.all([
      captureDuration(() => {
        return resolveSecretsAndEnvironment(
          params.orgId,
          agentCompose,
          firstAgent,
          vars,
          params.secrets,
          params.modelProvider,
          params.userId,
          params.allowedConnectorTypes,
          params.allowedCustomConnectorIds,
          params.modelProviderId,
          params.selectedModelOverride,
          params.preferPersonalProvider,
        );
      }),
      captureDuration(() => {
        return params.preloadedUserTimezone !== undefined
          ? Promise.resolve(null)
          : params.userId
            ? getUserPreferences(params.orgId, params.userId)
            : Promise.resolve(null);
      }),
      // Zero-layer concern: fetch previous run's model provider for compatibility check
      captureDuration(() => {
        return resolution?.previousRunId
          ? globalThis.services.db
              .select({ modelProvider: zeroRuns.modelProvider })
              .from(zeroRuns)
              .where(eq(zeroRuns.id, resolution.previousRunId))
              .limit(1)
              .then(([row]) => {
                return row?.modelProvider ?? undefined;
              })
          : Promise.resolve(undefined);
      }),
    ]);
  const resolveSecretsEnd = Date.now();
  const secretsResult = secretsResultTimed.value;
  const userPrefs = userPrefsTimed.value;
  const originalModelProvider = originalModelProviderTimed.value;

  const {
    secrets,
    environment,
    secretConnectorMap,
    secretConnectorMetadataMap,
    resolvedModelProvider,
    resolvedFramework,
    modelProviderConfig,
    selectedModel,
    connectorPermissionConfigs,
    mergedVars,
    billableFirewalls,
    modelUsageProvider,
  } = secretsResult;
  const userTimezone =
    params.preloadedUserTimezone ?? userPrefs?.timezone ?? undefined;
  const runtimeEnvironment = withRuntimeRunEnvironment(
    environment,
    params.triggerSource,
  );

  // Step 5: Compatibility checks for session continues.
  // - Provider: avoid mid-conversation base URL mismatches.
  // - Framework: persisted cliAgentSessionHistory is in the previous
  //   framework's format; switching binaries mid-thread can't replay it.
  //   resolvedFramework is the source of truth (provider-derived since
  //   #11649); the compose's `framework` field is no longer authoritative.
  const compatibilityChecksStart = Date.now();
  checkProviderCompatibility(originalModelProvider, resolvedModelProvider);
  checkFrameworkCompatibility(resolution?.sessionFramework, resolvedFramework);
  const compatibilityChecksEnd = Date.now();

  // Build permission manifest (base + auth entries for the runner).
  const mergePermissionsStart = Date.now();
  const permissionResult = mergePermissions(
    modelProviderConfig,
    connectorPermissionConfigs,
    params.permissionPolicies,
    mergedVars,
  );
  const mergePermissionsEnd = Date.now();

  const timingDetails: Omit<BuildZeroContextTimings, "diagnosticSpans"> = {
    resolveSourceAndOrg: resolveEnd - resolveStart,
    resolveSecrets: resolveSecretsEnd - resolveSecretsStart,
    userPreferences: userPrefsTimed.durationMs,
    previousRunModelProvider: originalModelProviderTimed.durationMs,
    compatibilityChecks: compatibilityChecksEnd - compatibilityChecksStart,
    mergePermissions: mergePermissionsEnd - mergePermissionsStart,
    resolveSecretsDetails: secretsResult.timings,
  };

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
      secretConnectorMetadataMap,
      sandboxToken: params.sandboxToken,
      artifacts,
      volumeVersions,
      additionalVolumes,
      environment: runtimeEnvironment,
      userTimezone,
      firewalls: permissionResult?.firewalls,
      networkPolicies: permissionResult?.networkPolicies,
      disallowedTools: params.disallowedTools,
      tools: params.tools,
      settings: params.settings,
      resumeSession,
      // Metadata for vm0_start event
      agentName: params.agentName,
      resumedFromCheckpointId: params.resumedFromCheckpointId,
      continuedFromSessionId: params.continuedFromSessionId,
      // Debug flag
      debugNoMockClaude: params.debugNoMockClaude,
      debugNoMockCodex: params.debugNoMockCodex,
      captureNetworkBodies: params.captureNetworkBodies,
      billableFirewalls,
      modelUsageProvider,
      // API start time for E2E timing metrics
      apiStartTime: params.apiStartTime,
      // Provider-derived framework — source of truth for downstream
      // dispatch (execution-preparer) and admission validation. Undefined
      // on the CLI path (no provider context); dispatch falls back to
      // compose framework via extractCliAgentType.
      resolvedFramework,
    },
    timings: {
      ...timingDetails,
      diagnosticSpans: buildDiagnosticSpans(timingDetails),
    },
    resolvedModelProvider,
    resolvedFramework,
    selectedModel,
  };
}
