import { eq, and } from "drizzle-orm";
import {
  extractAndGroupVariables,
  getFrameworkForType,
  getSecretNameForType,
  getEnvironmentMapping,
  getDefaultModel,
  hasAuthMethods,
  getSecretNamesForAuthMethod,
  getConnectorEnvironmentMapping,
  connectorTypeSchema,
  MODEL_PROVIDER_TYPES,
  VALID_CAPABILITIES,
  type ExperimentalFirewall,
  type ConnectorType,
  type ModelProviderType,
  type ModelProviderFramework,
} from "@vm0/core";
import { agentComposeVersions } from "../../db/schema/agent-compose";
import type { AgentComposeYaml } from "../../types/agent-compose";
import { badRequest, notFound } from "../errors";
import { getOrgData } from "../org/org-cache-service";
import { logger } from "../logger";
import type { ExecutionContext, ResumeSession, RuntimeOrg } from "./types";
import type { ArtifactSnapshot } from "../checkpoint/types";
import {
  resolveCheckpoint,
  resolveSession,
  resolveDirectConversation,
  type ConversationResolution,
} from "./resolvers";
import { expandEnvironmentFromCompose } from "./environment";
import { resolveOrg } from "../org/resolve-org";
import { getUserPreferences } from "../user/user-preferences-service";
import { getSecretValue, getSecretValues } from "../secret/secret-service";
import { getVariableValues } from "../variable/variable-service";
import { getDefaultModelProvider } from "../model-provider/model-provider-service";
import { connectors } from "../../db/schema/connector";
import { PROVIDER_HANDLERS } from "../connector/provider-registry";
import { refreshConnectorAccessToken } from "../connector/connector-service";

const log = logger("run:build-context");

/**
 * Model provider environment variables that indicate explicit configuration.
 * Includes both model-provider supported vars and alternative auth methods.
 */
const MODEL_PROVIDER_ENV_VARS = [
  // Model-provider supported
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  // Alternative auth methods (not model-provider supported yet)
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  // AWS Bedrock credentials
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
];

/**
 * Resolve model provider type from explicit value or pre-fetched default.
 * Single DB query: caller passes the already-fetched defaultProvider.
 */
function resolveProviderType(
  framework: string,
  defaultProvider: Awaited<ReturnType<typeof getDefaultModelProvider>>,
  explicitModelProvider?: string,
): ModelProviderType {
  let providerType: ModelProviderType;

  if (explicitModelProvider) {
    if (!(explicitModelProvider in MODEL_PROVIDER_TYPES)) {
      throw badRequest(
        `Unknown model provider type "${explicitModelProvider}". Valid types: ${Object.keys(MODEL_PROVIDER_TYPES).join(", ")}`,
      );
    }
    providerType = explicitModelProvider as ModelProviderType;
  } else if (defaultProvider?.type) {
    providerType = defaultProvider.type;
  } else {
    throw badRequest(
      "No model provider configured. " +
        "Run 'vm0 model-provider setup' to configure one, " +
        "or add environment variables to your vm0.yaml.",
    );
  }

  const providerFramework = getFrameworkForType(providerType);
  if (providerFramework !== framework) {
    throw badRequest(
      `Model provider "${providerType}" is not compatible with framework "${framework}". ` +
        `This provider is for "${providerFramework}" agents.`,
    );
  }

  return providerType;
}

/**
 * Resolve environment mapping for a provider type
 * Substitutes placeholders with actual values:
 * - $secret → single secret value
 * - $secrets.X → lookup secret X from secrets map (multi-auth)
 * - $model → selected model or default
 *
 * For providers without mapping, returns a single secret entry
 * For providers with mapping (e.g., moonshot), returns multiple env vars
 */
function resolveEnvironmentMapping(
  providerType: ModelProviderType,
  secretName: string | undefined,
  selectedModel: string | undefined,
  availableSecretNames?: Set<string>,
): Record<string, string> {
  const mapping = getEnvironmentMapping(providerType);

  if (!mapping) {
    // No mapping - return secret reference under its natural name
    const name = secretName || getSecretNameForType(providerType);
    if (!name) {
      return {};
    }
    return { [name]: `\${{ secrets.${name} }}` };
  }

  // Resolve model: use selected or fall back to default
  const model = selectedModel || getDefaultModel(providerType);

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value === "$secret") {
      // Single secret: emit template reference
      if (secretName) {
        result[key] = `\${{ secrets.${secretName} }}`;
      }
    } else if (value === "$model") {
      if (model) {
        result[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      // Multi-auth: emit template reference only if the secret is available
      // (environmentMapping may reference secrets from other auth methods)
      const lookupName = value.slice("$secrets.".length);
      if (!availableSecretNames || availableSecretNames.has(lookupName)) {
        result[key] = `\${{ secrets.${lookupName} }}`;
      }
    } else {
      // Literal value (e.g., base URL)
      result[key] = value;
    }
  }

  return result;
}

/**
 * Result of model provider secret resolution
 */
interface ModelProviderSecretResult {
  secrets: Record<string, string> | undefined;
  /** Environment template entries to merge into compose env before expansion.
   *  Secret-derived values use ${{ secrets.X }} references so they go through
   *  servicePlaceholders logic; literals (base URLs, model names) are plain strings. */
  injectedEnvironment: Record<string, string> | undefined;
}

/**
 * Resolve and inject model provider secret if needed
 * Only injects if no explicit model provider config in compose environment
 *
 * For providers with environment mapping (e.g., moonshot), resolves all env vars
 */
async function resolveModelProviderSecrets(
  orgId: string,
  userId: string,
  framework: string,
  hasExplicitModelProviderConfig: boolean,
  explicitModelProvider?: string,
): Promise<ModelProviderSecretResult> {
  let secrets: Record<string, string> | undefined;

  // Skip if explicit model provider config exists or framework doesn't use model providers
  if (
    hasExplicitModelProviderConfig ||
    (framework !== "claude-code" && framework !== "codex")
  ) {
    return { secrets, injectedEnvironment: undefined };
  }

  // Fetch default provider once (used for type resolution, model selection, and auth method)
  const defaultProvider = await getDefaultModelProvider(
    orgId,
    userId,
    framework as ModelProviderFramework,
  );

  const providerType = resolveProviderType(
    framework,
    defaultProvider,
    explicitModelProvider,
  );
  const selectedModel = defaultProvider?.selectedModel ?? undefined;

  // Handle multi-auth providers (like aws-bedrock)
  if (hasAuthMethods(providerType)) {
    const authMethod = defaultProvider?.authMethod;
    if (!authMethod) {
      log.debug(
        `Multi-auth provider ${providerType} has no auth method configured`,
      );
      return { secrets, injectedEnvironment: undefined };
    }

    // Get secret names for this auth method
    const secretNames = getSecretNamesForAuthMethod(providerType, authMethod);
    if (!secretNames || secretNames.length === 0) {
      log.debug(`No secret names found for ${providerType}/${authMethod}`);
      return { secrets, injectedEnvironment: undefined };
    }

    // Fetch all model-provider secrets by name
    const allSecretValues = await getSecretValues(
      orgId,
      userId,
      "model-provider",
    );
    const secretsMap: Record<string, string> = {};
    let hasAllRequired = true;

    for (const name of secretNames) {
      const value = allSecretValues[name];
      if (value) {
        secretsMap[name] = value;
      } else {
        log.debug(`Missing secret ${name} for ${providerType}/${authMethod}`);
        hasAllRequired = false;
      }
    }

    if (!hasAllRequired) {
      return { secrets, injectedEnvironment: undefined };
    }

    // Store secrets for masking
    secrets = secrets || {};
    Object.assign(secrets, secretsMap);

    // Resolve environment mapping as template references.
    // Pass available secret names so mapping entries for other auth methods are skipped.
    const injectedEnvironment = resolveEnvironmentMapping(
      providerType,
      undefined, // No single secret for multi-auth
      selectedModel,
      new Set(secretNames),
    );

    log.debug(
      `Resolved multi-auth model provider env: ${Object.keys(injectedEnvironment).join(", ")}`,
    );

    return { secrets, injectedEnvironment };
  }

  // Handle single-secret providers
  const secretName = getSecretNameForType(providerType);
  if (!secretName) {
    return { secrets, injectedEnvironment: undefined };
  }

  const secretValue = await getSecretValue(
    orgId,
    userId,
    secretName,
    "model-provider",
  );

  if (!secretValue) {
    return { secrets, injectedEnvironment: undefined };
  }

  // Store secret in secrets map for masking
  secrets = secrets || {};
  secrets[secretName] = secretValue;

  // Resolve environment mapping as template references
  const injectedEnvironment = resolveEnvironmentMapping(
    providerType,
    secretName,
    selectedModel,
  );

  log.debug(
    `Resolved model provider env: ${Object.keys(injectedEnvironment).join(", ")}`,
  );

  return { secrets, injectedEnvironment };
}

/**
 * Result of connector secret resolution
 */
interface ConnectorSecretResult {
  /** All raw connector secrets (for masking and direct secret reference resolution) */
  connectorSecrets: Record<string, string> | undefined;
  /** Environment variables mapped from OAuth connectors via environmentMapping */
  injectedEnvVars: Record<string, string> | undefined;
  /** Maps secret names to connector types for refresh-capable OAuth connectors */
  secretConnectorMap: Record<string, string> | undefined;
}

/**
 * Resolve and inject connector secrets if any connectors are connected.
 * For each connected connector, resolves its environmentMapping to produce
 * environment variables (e.g., GH_TOKEN, GITHUB_TOKEN for GitHub connector).
 */
async function resolveConnectorSecrets(
  orgId: string,
  userId: string,
): Promise<ConnectorSecretResult> {
  // Query connected connectors (need type for environmentMapping, authMethod for refresh filter)
  const userConnectors = await globalThis.services.db
    .select({ type: connectors.type, authMethod: connectors.authMethod })
    .from(connectors)
    .where(and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)));

  if (userConnectors.length === 0) {
    return {
      connectorSecrets: undefined,
      injectedEnvVars: undefined,
      secretConnectorMap: undefined,
    };
  }

  const connectorSecrets = await getSecretValues(orgId, userId, "connector");
  if (Object.keys(connectorSecrets).length === 0) {
    return {
      connectorSecrets: undefined,
      injectedEnvVars: undefined,
      secretConnectorMap: undefined,
    };
  }

  // Parse connector types upfront
  const validConnectors = userConnectors
    .map((c) => {
      const parsed = connectorTypeSchema.safeParse(c.type);
      return parsed.success
        ? { type: parsed.data, authMethod: c.authMethod }
        : null;
    })
    .filter(
      (c): c is { type: ConnectorType; authMethod: string } => c !== null,
    );

  // Refresh OAuth tokens in parallel.
  // Safe: each connector writes to distinct keys in connectorSecrets (e.g. github_access_token
  // vs slack_access_token), so concurrent mutations don't conflict.
  await Promise.all(
    validConnectors
      .filter(({ type }) => {
        const handler =
          PROVIDER_HANDLERS[type as keyof typeof PROVIDER_HANDLERS];
        return handler?.refreshToken;
      })
      .map(({ type }) =>
        refreshConnectorAccessToken(type, orgId, userId, connectorSecrets),
      ),
  );

  // Resolve environment mappings from connectors.
  const allInjectedEnvVars: Record<string, string> = {};

  for (const { type: connectorType } of validConnectors) {
    const mapping = getConnectorEnvironmentMapping(connectorType);
    for (const [envVar, valueRef] of Object.entries(mapping)) {
      if (valueRef.startsWith("$secrets.")) {
        const secretName = valueRef.slice("$secrets.".length);
        const secretValue = connectorSecrets[secretName];
        if (secretValue) {
          allInjectedEnvVars[envVar] = secretValue;
        }
      } else {
        allInjectedEnvVars[envVar] = valueRef;
      }
    }
  }

  if (Object.keys(allInjectedEnvVars).length > 0) {
    log.debug(
      `Resolved connector env vars: ${Object.keys(allInjectedEnvVars).join(", ")}`,
    );
  }

  // Build secretConnectorMap for refresh-capable OAuth connectors.
  // Maps access token secret name → connector type so the auth endpoint
  // can refresh expired tokens at runtime.
  const secretConnectorMap: Record<string, string> = {};
  for (const { type } of validConnectors) {
    if (!(type in PROVIDER_HANDLERS)) continue;
    const handler = PROVIDER_HANDLERS[type as keyof typeof PROVIDER_HANDLERS];
    if (handler.refreshToken) {
      secretConnectorMap[handler.getSecretName()] = type;
    }
  }

  return {
    connectorSecrets,
    injectedEnvVars: allInjectedEnvVars,
    secretConnectorMap:
      Object.keys(secretConnectorMap).length > 0
        ? secretConnectorMap
        : undefined,
  };
}

/**
 * Fetch secrets referenced in compose environment
 */
async function fetchReferencedSecrets(
  orgId: string,
  userId: string,
  environment: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (!environment) {
    return undefined;
  }

  const grouped = extractAndGroupVariables(environment);

  if (grouped.secrets.length === 0) {
    return undefined;
  }

  const referencedNames = grouped.secrets.map((r) => r.name);
  log.debug(`Secrets referenced in environment: ${referencedNames.join(", ")}`);

  // Only fetch user secrets for variable expansion (model-provider secrets are isolated)
  const userSecrets = await getSecretValues(orgId, userId, "user");
  log.debug(
    `Fetched ${Object.keys(userSecrets).length} user secret(s) for org ${orgId}`,
  );
  return userSecrets;
}

/**
 * Fetch server-stored variables and merge with CLI-provided vars
 * Priority: CLI vars > server-stored vars
 *
 * @param userId Clerk user ID
 * @param cliVars Variables from CLI --vars flag
 * @returns Merged variables (CLI takes precedence)
 */
async function fetchAndMergeVariables(
  orgId: string,
  userId: string,
  cliVars: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  const storedVars = await getVariableValues(orgId, userId);
  if (Object.keys(storedVars).length === 0) {
    return cliVars;
  }

  log.debug(
    `Fetched ${Object.keys(storedVars).length} stored variable(s) for org ${orgId}`,
  );

  // Merge: CLI vars override stored vars
  const merged = { ...storedVars, ...cliVars };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Parameters for building execution context
 */
interface BuildContextParams {
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
  // Pre-loaded compose content — skips DB lookup in new-run path if provided
  agentCompose?: unknown;
  // Required
  prompt: string;
  runId: string;
  sandboxToken: string;
  userId: string;
  // Metadata for vm0_start event
  agentName?: string;
  resumedFromCheckpointId?: string;
  continuedFromSessionId?: string;
  // Debug flag to force real Claude in mock environments (internal use only)
  debugNoMockClaude?: boolean;
  // Model provider for automatic secret injection
  modelProvider?: string;
  // Environment validation flag - when true, validates secrets/vars before running
  checkEnv?: boolean;
  // API start time for E2E timing metrics
  apiStartTime?: number;
  // Caller-resolved org slug and orgId for secret/variable/storage resolution.
  // When provided, used for both secrets and storage (artifacts/memory).
  // When not provided, resolved via resolveOrg fallback.
  orgSlug?: string;
  orgId?: string;
}

/**
 * Resolve source based on params
 * Returns ConversationResolution if a source is found, null for new runs
 */
async function resolveSource(
  params: BuildContextParams,
): Promise<ConversationResolution | null> {
  if (params.checkpointId) {
    log.debug(`Resolving checkpoint ${params.checkpointId}`);
    return resolveCheckpoint(params.checkpointId, params.userId);
  }

  if (params.sessionId) {
    log.debug(`Resolving session ${params.sessionId}`);
    return resolveSession(params.sessionId, params.userId);
  }

  if (params.conversationId && params.agentComposeVersionId) {
    log.debug(`Resolving conversation ${params.conversationId}`);
    return resolveDirectConversation(
      params.conversationId,
      params.agentComposeVersionId,
      params.userId,
    );
  }

  return null;
}

/**
 * Load agent compose for new runs (no resolution)
 */
async function loadAgentComposeForNewRun(
  agentComposeVersionId: string,
): Promise<unknown> {
  const [version] = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, agentComposeVersionId))
    .limit(1);

  if (!version) {
    throw notFound("Agent compose version not found");
  }

  return version.content;
}

/**
 * Resolve all secrets (user, model provider, connector) and expand environment.
 * Extracted from buildExecutionContext to reduce complexity.
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
  checkEnv: boolean | undefined,
  userId: string,
): Promise<{
  secrets: Record<string, string> | undefined;
  environment: Record<string, string> | undefined;
  secretConnectorMap: Record<string, string> | undefined;
}> {
  // Model provider secret injection
  const hasExplicitModelProviderConfig = MODEL_PROVIDER_ENV_VARS.some(
    (v) => firstAgent?.environment?.[v] !== undefined,
  );
  const framework = firstAgent?.framework || "claude-code";

  // Run all secret resolution and variable fetching in parallel.
  // The three resolve functions have independent DB queries (different secret types),
  // so there is no data dependency between them.
  const [dbSecrets, modelProviderResult, connectorResult, mergedVars] =
    await Promise.all([
      fetchReferencedSecrets(orgId, userId, firstAgent?.environment),
      resolveModelProviderSecrets(
        orgId,
        userId,
        framework,
        hasExplicitModelProviderConfig,
        modelProvider,
      ),
      resolveConnectorSecrets(orgId, userId),
      fetchAndMergeVariables(orgId, userId, vars),
    ]);

  // Single secrets map with explicit priority (later overrides earlier).
  // All sources are included — extra secrets are harmless for environment expansion
  // (only referenced ${{ secrets.* }} names are looked up) and for auth resolution
  // (auth endpoint only resolves templates it receives).
  const hasSecrets =
    connectorResult.connectorSecrets ||
    connectorResult.injectedEnvVars ||
    modelProviderResult.secrets ||
    dbSecrets ||
    cliSecrets;
  const secrets: Record<string, string> | undefined = hasSecrets
    ? {
        ...connectorResult.connectorSecrets, // lowest: raw connector secrets
        ...connectorResult.injectedEnvVars, // connector env mappings override raw
        ...modelProviderResult.secrets, // model provider
        ...dbSecrets, // DB user secrets
        ...cliSecrets, // highest: CLI --secrets
      }
    : undefined;

  // Filter secretConnectorMap: remove keys overridden by higher-priority sources.
  // If a secret is provided by CLI, user DB, or model-provider, OAuth refresh should
  // not overwrite it at runtime.
  let secretConnectorMap: Record<string, string> | undefined;
  if (connectorResult.secretConnectorMap) {
    const overrideKeys = new Set(
      [
        connectorResult.injectedEnvVars,
        modelProviderResult.secrets,
        dbSecrets,
        cliSecrets,
      ].flatMap((s) => (s ? Object.keys(s) : [])),
    );
    const filtered = Object.fromEntries(
      Object.entries(connectorResult.secretConnectorMap).filter(
        ([key]) => !overrideKeys.has(key),
      ),
    );
    if (Object.keys(filtered).length) secretConnectorMap = filtered;
  }

  // Expand environment variables from compose config.
  // Model provider env vars are passed as additionalEnvironment so they go through
  // the same servicePlaceholders logic (secret-derived values use ${{ secrets.X }} templates).
  const { environment } = expandEnvironmentFromCompose(
    agentCompose,
    mergedVars,
    secrets,
    checkEnv,
    modelProviderResult.injectedEnvironment,
  );

  return { secrets, environment, secretConnectorMap };
}

/**
 * Apply resolution defaults to context variables.
 * Params override resolution values (explicit CLI args win).
 */
function applyResolutionDefaults(
  params: BuildContextParams,
  resolution: ConversationResolution,
): {
  agentComposeVersionId: string;
  agentCompose: unknown;
  artifactName: string | undefined;
  artifactVersion: string | undefined;
  memoryName: string | undefined;
  vars: Record<string, string> | undefined;
  volumeVersions: Record<string, string> | undefined;
  resumeSession: ResumeSession;
  resumeArtifact: ArtifactSnapshot | undefined;
} {
  const artifactName = params.artifactName || resolution.artifactName;
  const artifactVersion = params.artifactVersion || resolution.artifactVersion;

  // Build resumeArtifact if applicable
  let resumeArtifact: ArtifactSnapshot | undefined;
  if (resolution.buildResumeArtifact && artifactName) {
    resumeArtifact = {
      artifactName,
      artifactVersion: artifactVersion || "latest",
    };
  }

  return {
    agentComposeVersionId:
      params.agentComposeVersionId || resolution.agentComposeVersionId,
    agentCompose: resolution.agentCompose,
    artifactName,
    artifactVersion,
    memoryName: params.memoryName || resolution.memoryName,
    vars: params.vars || resolution.vars,
    volumeVersions: params.volumeVersions || resolution.volumeVersions,
    resumeSession: {
      sessionId: resolution.conversationData.cliAgentSessionId,
      sessionHistory: resolution.conversationData.cliAgentSessionHistory,
      workingDir: resolution.workingDir,
    },
    resumeArtifact,
  };
}

/**
 * Resolve the Runtime Org for this execution.
 *
 * The Runtime Org (orgId + userId) determines secrets, variables,
 * connectors, model providers, artifacts, and memories.
 * See docs/resource-model.md for the full resource model.
 *
 * When params.orgId is not provided, the user's default org is used.
 */
async function resolveOrgs(params: BuildContextParams): Promise<{
  runtimeClerkOrgId: string;
  pendingRuntimeScope: Promise<RuntimeOrg> | RuntimeOrg;
}> {
  if (params.orgId) {
    if (params.orgSlug) {
      return {
        runtimeClerkOrgId: params.orgId,
        pendingRuntimeScope: {
          slug: params.orgSlug,
          orgId: params.orgId,
        },
      };
    }
    // Have orgId but no slug — resolve slug from org cache
    const orgData = await getOrgData(params.orgId);
    return {
      runtimeClerkOrgId: params.orgId,
      pendingRuntimeScope: {
        slug: orgData.slug,
        orgId: params.orgId,
      },
    };
  }
  // No explicit org — default org is used
  const { org } = await resolveOrg(params.userId);
  return {
    runtimeClerkOrgId: org.orgId,
    pendingRuntimeScope: {
      slug: org.slug,
      orgId: org.orgId,
    },
  };
}

interface BuildContextTimings {
  resolveSourceAndOrg: number;
  resolveSecrets: number;
}

interface BuildContextResult {
  context: ExecutionContext;
  runtimeOrg: RuntimeOrg;
  timings: BuildContextTimings;
}

/**
 * Build ExperimentalFirewall manifest from agent compose's expanded experimental_firewall.
 * Returns null if no firewall configs are declared.
 *
 * Reads pre-expanded ExpandedFirewallConfig objects (resolved at compose time)
 * and maps them to a flat firewall entry array: [{ name, ref, apis }].
 *
 * Placeholder env var injection is handled by expandEnvironmentFromCompose.
 */
function buildExperimentalFirewall(
  agentCompose: unknown,
): ExperimentalFirewall | null {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return null;

  const firstAgent = Object.values(compose.agents)[0];
  const firewallConfigs = firstAgent?.experimental_firewall;
  if (!firewallConfigs || firewallConfigs.length === 0) return null;

  return firewallConfigs.map((fw) => ({
    name: fw.name,
    ref: fw.ref,
    apis: fw.apis.map((api) => ({
      base: api.base,
      auth: api.auth,
      ...(api.permissions ? { permissions: api.permissions } : {}),
    })),
  }));
}

/**
 * Extract experimental_capabilities from the first agent in compose.
 * Returns undefined if not present or empty.
 */
function buildExperimentalCapabilities(
  agentCompose: unknown,
): (typeof VALID_CAPABILITIES)[number][] | undefined {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return undefined;

  const firstAgent = Object.values(compose.agents)[0];
  const capabilities = firstAgent?.experimental_capabilities;
  if (!capabilities || capabilities.length === 0) return undefined;

  return [...capabilities];
}

/**
 * Build unified execution context from various parameter sources.
 * Supports: new run, checkpoint resume, session continue.
 *
 * Parameter expansion:
 * - checkpointId: Expands to checkpoint snapshot (config, conversation, artifact, volumes)
 * - sessionId: Expands to session data (config, conversation, artifact=latest)
 * - Explicit parameters override expanded values
 */
export async function buildExecutionContext(
  params: BuildContextParams,
): Promise<BuildContextResult> {
  log.debug(`Building execution context for ${params.runId}`);
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
  let resumeSession: ResumeSession | undefined;
  let resumeArtifact: ArtifactSnapshot | undefined;

  // Step 1: Resolve source and orgs in parallel (independent operations).
  // resolveSource loads checkpoint/session/conversation data.
  // resolveOrgs resolves the runtime org for secrets and storage.
  const resolveStart = Date.now();
  const [resolution, { runtimeClerkOrgId, pendingRuntimeScope }] =
    await Promise.all([resolveSource(params), resolveOrgs(params)]);
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

  // Step 4: Resolve secrets, user preferences, and runtime scope in parallel.
  // pendingRuntimeScope may already be resolved (when orgId was not explicit).
  const resolveSecretsStart = Date.now();
  const [secretsResult, userPrefs, runtimeOrg] = await Promise.all([
    resolveSecretsAndEnvironment(
      runtimeClerkOrgId,
      agentCompose,
      firstAgent,
      vars,
      params.secrets,
      params.modelProvider,
      params.checkEnv,
      params.userId,
    ),
    params.userId
      ? getUserPreferences(runtimeClerkOrgId, params.userId)
      : Promise.resolve(null),
    Promise.resolve(pendingRuntimeScope),
  ]);
  const resolveSecretsEnd = Date.now();

  const { secrets, environment, secretConnectorMap } = secretsResult;
  const userTimezone = userPrefs?.timezone ?? undefined;

  // Build experimental firewall manifest (base + auth entries for the runner)
  const experimentalFirewall =
    buildExperimentalFirewall(agentCompose) ?? undefined;

  // Build experimental capabilities list from compose
  const experimentalCapabilities = buildExperimentalCapabilities(agentCompose);

  // Build final execution context
  return {
    runtimeOrg,
    context: {
      runId: params.runId,
      userId: params.userId,
      agentComposeVersionId,
      agentCompose,
      prompt: params.prompt,
      vars,
      secrets,
      secretConnectorMap,
      sandboxToken: params.sandboxToken,
      artifactName,
      artifactVersion,
      memoryName,
      volumeVersions,
      environment,
      userTimezone,
      experimentalFirewall,
      experimentalCapabilities,
      resumeSession,
      resumeArtifact,
      // Metadata for vm0_start event
      agentName: params.agentName,
      resumedFromCheckpointId: params.resumedFromCheckpointId,
      continuedFromSessionId: params.continuedFromSessionId,
      // Debug flag
      debugNoMockClaude: params.debugNoMockClaude,
      // API start time for E2E timing metrics
      apiStartTime: params.apiStartTime,
    },
    timings: {
      resolveSourceAndOrg: resolveEnd - resolveStart,
      resolveSecrets: resolveSecretsEnd - resolveSecretsStart,
    },
  };
}
