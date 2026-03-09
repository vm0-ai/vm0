import { eq, and } from "drizzle-orm";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getFrameworkForType,
  getSecretNameForType,
  getEnvironmentMapping,
  getDefaultModel,
  hasAuthMethods,
  getSecretNamesForAuthMethod,
  getConnectorEnvironmentMapping,
  getConnectorProxyConfig,
  connectorTypeSchema,
  MODEL_PROVIDER_TYPES,
  type ConnectorType,
  type ExperimentalConnectors,
  type ModelProviderType,
  type ModelProviderFramework,
} from "@vm0/core";
import { agentComposeVersions } from "../../db/schema/agent-compose";
import { scopes } from "../../db/schema/scope";
import { badRequest, notFound } from "../errors";
import { logger } from "../logger";
import type { ExecutionContext, ResumeSession, RuntimeScope } from "./types";
import type { ArtifactSnapshot } from "../checkpoint/types";
import {
  resolveCheckpoint,
  resolveSession,
  resolveDirectConversation,
  type ConversationResolution,
} from "./resolvers";
import { expandEnvironmentFromCompose } from "./environment";
import { getDefaultScope } from "../scope/scope-member-service";
import { getUserPreferences } from "../user/user-preferences-service";
import { getSecretValue, getSecretValues } from "../secret/secret-service";
import { getVariableValues } from "../variable/variable-service";
import { getDefaultModelProvider } from "../model-provider/model-provider-service";
import { connectors } from "../../db/schema/connector";
import { PROVIDER_HANDLERS } from "../connector/provider-registry";
import { upsertConnectorSecret } from "../connector/connector-service";

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
  credentialValue: string | undefined,
  selectedModel: string | undefined,
  credentialsMap?: Record<string, string>,
): Record<string, string> {
  const mapping = getEnvironmentMapping(providerType);

  if (!mapping) {
    // No mapping - return credential directly under its natural name
    const credentialName = getSecretNameForType(providerType);
    if (!credentialName || !credentialValue) {
      // Multi-auth providers should have environmentMapping, this shouldn't happen
      return {};
    }
    return { [credentialName]: credentialValue };
  }

  // Resolve model: use selected or fall back to default
  const model = selectedModel || getDefaultModel(providerType);

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value === "$secret") {
      // Single secret value
      if (credentialValue) {
        result[key] = credentialValue;
      }
    } else if (value === "$model") {
      if (model) {
        result[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      // Multi-auth: lookup secret from map
      const credName = value.slice("$secrets.".length);
      const credValue = credentialsMap?.[credName];
      if (credValue) {
        result[key] = credValue;
      }
      // Skip if undefined (optional secret)
    } else {
      // Literal value (e.g., base URL)
      result[key] = value;
    }
  }

  return result;
}

/**
 * Result of model provider credential resolution
 */
interface ModelProviderCredentialResult {
  credentials: Record<string, string> | undefined;
  /** Environment variables to inject (may be multiple for providers with mapping) */
  injectedEnvVars: Record<string, string> | undefined;
}

/**
 * Resolve and inject model provider credential if needed
 * Only injects if no explicit model provider config in compose environment
 *
 * For providers with environment mapping (e.g., moonshot), resolves all env vars
 */
async function resolveModelProviderCredential(
  scopeId: string,
  userId: string,
  framework: string,
  hasExplicitModelProviderConfig: boolean,
  explicitModelProvider?: string,
): Promise<ModelProviderCredentialResult> {
  let credentials: Record<string, string> | undefined;

  // Skip if explicit model provider config exists or framework doesn't use model providers
  if (
    hasExplicitModelProviderConfig ||
    (framework !== "claude-code" && framework !== "codex")
  ) {
    return { credentials, injectedEnvVars: undefined };
  }

  // Fetch default provider once (used for type resolution, model selection, and auth method)
  const defaultProvider = await getDefaultModelProvider(
    scopeId,
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
      return { credentials, injectedEnvVars: undefined };
    }

    // Get credential names for this auth method
    const credentialNames = getSecretNamesForAuthMethod(
      providerType,
      authMethod,
    );
    if (!credentialNames || credentialNames.length === 0) {
      log.debug(`No credential names found for ${providerType}/${authMethod}`);
      return { credentials, injectedEnvVars: undefined };
    }

    // Fetch all model-provider credentials by name
    const allCredentialValues = await getSecretValues(
      scopeId,
      userId,
      "model-provider",
    );
    const credentialsMap: Record<string, string> = {};
    let hasAllRequired = true;

    for (const name of credentialNames) {
      const value = allCredentialValues[name];
      if (value) {
        credentialsMap[name] = value;
      } else {
        log.debug(
          `Missing credential ${name} for ${providerType}/${authMethod}`,
        );
        hasAllRequired = false;
      }
    }

    if (!hasAllRequired) {
      return { credentials, injectedEnvVars: undefined };
    }

    // Store credentials for masking
    credentials = credentials || {};
    Object.assign(credentials, credentialsMap);

    // Resolve environment mapping with credentials map
    const injectedEnvVars = resolveEnvironmentMapping(
      providerType,
      undefined, // No single credential for multi-auth
      selectedModel,
      credentialsMap,
    );

    log.debug(
      `Resolved multi-auth model provider env vars: ${Object.keys(injectedEnvVars).join(", ")}`,
    );

    return { credentials, injectedEnvVars };
  }

  // Handle legacy single-credential providers
  const credentialName = getSecretNameForType(providerType);
  if (!credentialName) {
    return { credentials, injectedEnvVars: undefined };
  }

  const credentialValue = await getSecretValue(
    scopeId,
    userId,
    credentialName,
    "model-provider",
  );

  if (!credentialValue) {
    return { credentials, injectedEnvVars: undefined };
  }

  // Store credential in credentials map for masking
  credentials = credentials || {};
  credentials[credentialName] = credentialValue;

  // Resolve environment mapping (handles $credential and $model substitution)
  const injectedEnvVars = resolveEnvironmentMapping(
    providerType,
    credentialValue,
    selectedModel,
  );

  log.debug(
    `Resolved model provider env vars: ${Object.keys(injectedEnvVars).join(", ")}`,
  );

  return { credentials, injectedEnvVars };
}

/**
 * Generic connector access token refresh.
 * Looks up the connector's handler from PROVIDER_HANDLERS, calls its refreshToken
 * method, persists new tokens, and updates the in-memory secrets map.
 *
 * Returns null if refresh token is unavailable, OAuth credentials are missing,
 * or the refresh fails (caller should fall back to the existing access token).
 */
async function refreshConnectorAccessToken(
  connectorType: string,
  scopeId: string,
  userId: string,
  connectorSecrets: Record<string, string>,
): Promise<string | null> {
  const handler =
    PROVIDER_HANDLERS[connectorType as keyof typeof PROVIDER_HANDLERS];
  if (!handler?.refreshToken || !handler.getRefreshSecretName) {
    return null;
  }

  const refreshTokenSecret = handler.getRefreshSecretName();
  const currentRefreshToken = connectorSecrets[refreshTokenSecret];
  if (!currentRefreshToken) {
    log.debug(`No ${connectorType} refresh token available, skipping`);
    return null;
  }

  const env = globalThis.services.env;
  const clientId = handler.getClientId(env);
  const clientSecret = handler.getClientSecret(env);

  if (!clientId || !clientSecret) {
    log.debug(
      `${connectorType} OAuth credentials not configured, skipping token refresh`,
    );
    return null;
  }

  const accessTokenSecret = handler.getSecretName();

  try {
    const result = await handler.refreshToken(
      clientId,
      clientSecret,
      currentRefreshToken,
    );

    // Persist new tokens to database
    await upsertConnectorSecret(
      scopeId,
      userId,
      accessTokenSecret,
      result.accessToken,
    );
    if (result.refreshToken) {
      await upsertConnectorSecret(
        scopeId,
        userId,
        refreshTokenSecret,
        result.refreshToken,
      );
    }

    // Update in-memory secrets map so subsequent mapping uses fresh token
    connectorSecrets[accessTokenSecret] = result.accessToken;
    if (result.refreshToken) {
      connectorSecrets[refreshTokenSecret] = result.refreshToken;
    }

    log.debug(`${connectorType} access token refreshed successfully`);
    return result.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn(`${connectorType} token refresh failed: ${message}`);
    return null;
  }
}

/**
 * Result of connector credential resolution
 */
interface ConnectorCredentialResult {
  credentials: Record<string, string> | undefined;
  /** Environment variables to inject from connected connectors */
  injectedEnvVars: Record<string, string> | undefined;
}

/**
 * Resolve and inject connector credentials if any connectors are connected.
 * For each connected connector, resolves its environmentMapping to produce
 * environment variables (e.g., GH_TOKEN, GITHUB_TOKEN for GitHub connector).
 */
async function resolveConnectorCredentials(
  scopeId: string,
  userId: string,
): Promise<ConnectorCredentialResult> {
  let credentials: Record<string, string> | undefined;

  // Query connected connectors directly (only need the type for environmentMapping)
  const userConnectors = await globalThis.services.db
    .select({ type: connectors.type })
    .from(connectors)
    .where(and(eq(connectors.scopeId, scopeId), eq(connectors.userId, userId)));

  if (userConnectors.length === 0) {
    return { credentials, injectedEnvVars: undefined };
  }

  const connectorSecrets = await getSecretValues(scopeId, userId, "connector");
  if (Object.keys(connectorSecrets).length === 0) {
    return { credentials, injectedEnvVars: undefined };
  }

  const allInjectedEnvVars: Record<string, string> = {};

  // Parse connector types upfront
  const validConnectors = userConnectors
    .map((c) => connectorTypeSchema.safeParse(c.type))
    .filter((r) => r.success)
    .map((r) => r.data);

  // Refresh all OAuth tokens in parallel.
  // Safe: each connector writes to distinct keys in connectorSecrets (e.g. github_access_token
  // vs slack_access_token), so concurrent mutations don't conflict.
  await Promise.all(
    validConnectors
      .filter((type) => {
        const handler =
          PROVIDER_HANDLERS[type as keyof typeof PROVIDER_HANDLERS];
        return handler?.refreshToken;
      })
      .map((type) =>
        refreshConnectorAccessToken(type, scopeId, userId, connectorSecrets),
      ),
  );

  // Resolve environment mappings (uses refreshed secrets)
  for (const connectorType of validConnectors) {
    const mapping = getConnectorEnvironmentMapping(connectorType);

    for (const [envVar, valueRef] of Object.entries(mapping)) {
      if (valueRef.startsWith("$secrets.")) {
        const secretName = valueRef.slice("$secrets.".length);
        const secretValue = connectorSecrets[secretName];
        if (secretValue) {
          allInjectedEnvVars[envVar] = secretValue;
          credentials = credentials || {};
          credentials[secretName] = secretValue;
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

  return { credentials, injectedEnvVars: allInjectedEnvVars };
}

/**
 * Fetch credentials referenced in compose environment
 */
async function fetchReferencedCredentials(
  scopeId: string,
  userId: string,
  environment: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (!environment) {
    return undefined;
  }

  const refs = extractVariableReferences(environment);
  const grouped = groupVariablesBySource(refs);

  if (grouped.credentials.length === 0 && grouped.secrets.length === 0) {
    return undefined;
  }

  const referencedNames = [
    ...grouped.credentials.map((r) => r.name),
    ...grouped.secrets.map((r) => r.name),
  ];
  log.debug(`Secrets referenced in environment: ${referencedNames.join(", ")}`);

  // Only fetch user secrets for variable expansion (model-provider secrets are isolated)
  const userSecrets = await getSecretValues(scopeId, userId, "user");
  log.debug(
    `Fetched ${Object.keys(userSecrets).length} user secret(s) from scope ${scopeId}`,
  );
  return userSecrets;
}

/**
 * Merge DB secrets with CLI secrets (CLI takes priority)
 */
function mergeSecrets(
  dbSecrets: Record<string, string> | undefined,
  cliSecrets: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!dbSecrets) {
    return cliSecrets;
  }
  return { ...dbSecrets, ...cliSecrets };
}

/**
 * Auto-inject environment variables from a provider source (model provider, connector, etc.)
 * Returns the potentially modified environment.
 *
 * Only injects variables not already set (user-defined environment takes precedence).
 *
 * @param source - Label for logging (e.g., "model provider", "connector")
 */
function autoInjectEnvVarsToEnvironment(
  environment: Record<string, string> | undefined,
  injectedEnvVars: Record<string, string> | undefined,
  source: string = "provider",
): Record<string, string> | undefined {
  if (!injectedEnvVars || Object.keys(injectedEnvVars).length === 0) {
    return environment;
  }

  const result = environment ? { ...environment } : {};
  const injectedKeys: string[] = [];

  for (const [key, value] of Object.entries(injectedEnvVars)) {
    // Only inject if not already set (user-defined environment takes precedence)
    if (!(key in result)) {
      result[key] = value;
      injectedKeys.push(key);
    }
  }

  if (injectedKeys.length > 0) {
    log.debug(
      `Auto-injected ${source} env vars to environment: ${injectedKeys.join(", ")}`,
    );
  }

  return result;
}

/**
 * Merge connector-resolved secrets into the secrets pool, but ONLY for secrets
 * that the compose explicitly references via ${{ secrets.* }}.
 *
 * This ensures connector secrets are only injected when the compose asks for them
 * (via skills declaring vm0_secrets), not unconditionally.
 *
 * Precedence: user/CLI secrets > connector secrets (connector only fills gaps).
 */
function mergeConnectorSecretsForReferences(
  composeEnvironment: Record<string, string> | undefined,
  existingSecrets: Record<string, string> | undefined,
  connectorEnvVars: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!composeEnvironment || !connectorEnvVars) {
    return existingSecrets;
  }

  // Extract ${{ secrets.* }} references from compose environment
  const refs = extractVariableReferences(composeEnvironment);
  const grouped = groupVariablesBySource(refs);

  if (grouped.secrets.length === 0) {
    return existingSecrets;
  }

  const referencedSecretNames = new Set(grouped.secrets.map((r) => r.name));
  let merged = existingSecrets;

  for (const name of referencedSecretNames) {
    // Skip if already provided by user/CLI secrets
    if (merged?.[name]) {
      continue;
    }

    // Check if connector can satisfy this secret
    const connectorValue = connectorEnvVars[name];
    if (connectorValue) {
      merged = merged || {};
      merged[name] = connectorValue;
      log.debug(
        `Connector secret satisfying ${"$"}{{ secrets.${name} }} reference`,
      );
    }
  }

  return merged;
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
  scopeId: string,
  userId: string,
  cliVars: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  const storedVars = await getVariableValues(scopeId, userId);
  if (Object.keys(storedVars).length === 0) {
    return cliVars;
  }

  log.debug(
    `Fetched ${Object.keys(storedVars).length} stored variable(s) from scope ${scopeId}`,
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
  // Model provider for automatic credential injection
  modelProvider?: string;
  // Environment validation flag - when true, validates secrets/vars before running
  checkEnv?: boolean;
  // API start time for E2E timing metrics
  apiStartTime?: number;
  // Caller-resolved scope ID and slug for credential/variable/storage resolution.
  // When provided, used for both credentials and storage (artifacts/memory).
  // When not provided, resolved via getDefaultScope fallback.
  scopeId?: string;
  scopeSlug?: string;
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
 * Resolve all credentials (user, model provider, connector) and expand environment.
 * Extracted from buildExecutionContext to reduce complexity.
 */
async function resolveCredentialsAndEnvironment(
  scopeId: string,
  agentCompose: unknown,
  firstAgent:
    | { environment?: Record<string, string>; framework?: string }
    | undefined,
  vars: Record<string, string> | undefined,
  cliSecrets: Record<string, string> | undefined,
  modelProvider: string | undefined,
  runId: string,
  checkEnv: boolean | undefined,
  userId: string,
): Promise<{
  secrets: Record<string, string> | undefined;
  credentials: Record<string, string> | undefined;
  environment: Record<string, string> | undefined;
}> {
  // Model provider credential injection
  const hasExplicitModelProviderConfig = MODEL_PROVIDER_ENV_VARS.some(
    (v) => firstAgent?.environment?.[v] !== undefined,
  );
  const framework = firstAgent?.framework || "claude-code";

  // Run all credential resolution and variable fetching in parallel.
  // The three resolve functions have independent DB queries (different secret types),
  // so there is no data dependency between them.
  const [dbSecrets, modelProviderResult, connectorResult, mergedVars] =
    await Promise.all([
      fetchReferencedCredentials(scopeId, userId, firstAgent?.environment),
      resolveModelProviderCredential(
        scopeId,
        userId,
        framework,
        hasExplicitModelProviderConfig,
        modelProvider,
      ),
      resolveConnectorCredentials(scopeId, userId),
      fetchAndMergeVariables(scopeId, userId, vars),
    ]);

  // Merge credentials from all sources (connector > model-provider > user).
  // Return undefined when no source contributed credentials (preserves original behavior).
  const hasCredentials =
    dbSecrets || modelProviderResult.credentials || connectorResult.credentials;
  const credentials: Record<string, string> | undefined = hasCredentials
    ? {
        ...dbSecrets,
        ...modelProviderResult.credentials,
        ...connectorResult.credentials,
      }
    : undefined;

  // Merge secrets: DB user secrets + CLI secrets (CLI takes priority)
  let secrets = mergeSecrets(dbSecrets, cliSecrets);

  // Merge connector secrets into secrets pool for explicit ${{ secrets.* }} references only.
  // Connector secrets only fill gaps — user/CLI secrets take precedence.
  secrets = mergeConnectorSecretsForReferences(
    firstAgent?.environment,
    secrets,
    connectorResult.injectedEnvVars,
  );

  const modelProviderEnvVars = modelProviderResult.injectedEnvVars;

  // Expand environment variables from compose config
  const { environment: expandedEnvironment } = expandEnvironmentFromCompose(
    agentCompose,
    mergedVars,
    secrets,
    credentials,
    userId,
    runId,
    checkEnv,
  );

  // Auto-inject model provider env vars into environment
  const environment = autoInjectEnvVarsToEnvironment(
    expandedEnvironment,
    modelProviderEnvVars,
    "model provider",
  );

  return { secrets, credentials, environment };
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
  secretNames: string[] | undefined;
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
    secretNames: resolution.secretNames,
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
 * Resolve the Runtime Scope for this execution.
 *
 * The Runtime Scope (scopeId + userId) determines secrets, variables,
 * connectors, model providers, artifacts, and memories.
 * See docs/resource-model.md for the full resource model.
 *
 * When params.scopeId is not provided, the user's default scope is used.
 */
async function resolveScopes(params: BuildContextParams): Promise<{
  runtimeScopeId: string;
  pendingRuntimeScope:
    | Promise<{ id: string; slug: string }>
    | { id: string; slug: string };
}> {
  if (params.scopeId) {
    if (params.scopeSlug) {
      return {
        runtimeScopeId: params.scopeId,
        pendingRuntimeScope: { id: params.scopeId, slug: params.scopeSlug },
      };
    }
    // Fallback: query slug from DB when caller didn't provide it
    return {
      runtimeScopeId: params.scopeId,
      pendingRuntimeScope: globalThis.services.db
        .select({ slug: scopes.slug })
        .from(scopes)
        .where(eq(scopes.id, params.scopeId))
        .limit(1)
        .then(([result]) => ({
          id: params.scopeId as string,
          slug: result?.slug ?? "",
        })),
    };
  }
  // No explicit scope — default scope is used
  const { scope } = await getDefaultScope(params.userId);
  return {
    runtimeScopeId: scope.id,
    pendingRuntimeScope: { id: scope.id, slug: scope.slug },
  };
}

interface BuildContextTimings {
  resolveSourceAndScope: number;
  resolveCredentials: number;
}

interface BuildContextResult {
  context: ExecutionContext;
  runtimeScope: RuntimeScope;
  timings: BuildContextTimings;
}

/**
 * Build ExperimentalConnectors from agent compose's experimental_connectors array.
 * Returns null if no connectors are declared.
 *
 * For each declared connector name:
 * 1. Validates it's a known connector type with proxy config
 * 2. Looks up targets and auth from CONNECTOR_PROXY_CONFIGS
 * 3. Generates a placeholder token (vm0_conn_{name})
 */
function buildExperimentalConnectors(
  agentCompose: unknown,
): ExperimentalConnectors | null {
  const compose = agentCompose as
    | { agents?: Record<string, { experimental_connectors?: string[] }> }
    | undefined;
  if (!compose?.agents) return null;

  const firstAgent = Object.values(compose.agents)[0];
  const connectorNames = firstAgent?.experimental_connectors;
  if (!connectorNames || connectorNames.length === 0) return null;

  const connectors = connectorNames.map((name) => {
    // Validate connector type exists
    const parsed = connectorTypeSchema.safeParse(name);
    if (!parsed.success) {
      throw badRequest(`Unknown connector type: "${name}"`);
    }
    const connectorType = parsed.data as ConnectorType;

    // Look up proxy config (targets + auth)
    const proxyConfig = getConnectorProxyConfig(connectorType);
    if (!proxyConfig) {
      throw badRequest(
        `Connector "${name}" does not support proxy-side token replacement`,
      );
    }

    return {
      name,
      targets: proxyConfig.targets,
      placeholder: `vm0_conn_${name}`,
      auth: proxyConfig.auth,
    };
  });

  return { connectors };
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
  let secrets: Record<string, string> | undefined = params.secrets;
  let secretNames: string[] | undefined;
  let memoryName: string | undefined = params.memoryName;
  let volumeVersions: Record<string, string> | undefined =
    params.volumeVersions;
  let resumeSession: ResumeSession | undefined;
  let resumeArtifact: ArtifactSnapshot | undefined;

  // Step 1: Resolve source and scopes in parallel (independent operations).
  // resolveSource loads checkpoint/session/conversation data.
  // resolveScopes resolves the runtime scope for credentials and storage.
  const resolveStart = Date.now();
  const [resolution, { runtimeScopeId, pendingRuntimeScope }] =
    await Promise.all([resolveSource(params), resolveScopes(params)]);
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
    secretNames = defaults.secretNames;
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

    // For new runs, derive secretNames from provided secrets
    if (secrets) {
      secretNames = Object.keys(secrets);
    }
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

  // Step 4: Resolve credentials, user preferences, and runtime scope in parallel.
  // pendingRuntimeScope may already be resolved (when scopeId was not explicit).
  const resolveCredentialsStart = Date.now();
  const [credentialsResult, userPrefs, runtimeScope] = await Promise.all([
    resolveCredentialsAndEnvironment(
      runtimeScopeId,
      agentCompose,
      firstAgent,
      vars,
      params.secrets,
      params.modelProvider,
      params.runId,
      params.checkEnv,
      params.userId,
    ),
    params.userId ? getUserPreferences(params.userId) : Promise.resolve(null),
    Promise.resolve(pendingRuntimeScope),
  ]);
  const resolveCredentialsEnd = Date.now();

  const {
    secrets: resolvedSecrets,
    credentials: resolvedCredentials,
    environment,
  } = credentialsResult;
  secrets = resolvedSecrets;
  const userTimezone = userPrefs?.timezone ?? undefined;

  // Step 5: Merge credentials into secrets for client-side log masking
  // Credentials are server-stored user-level secrets and must be masked like CLI secrets
  // Priority: CLI --secrets > credentials (platform-stored)
  const mergedSecrets = resolvedCredentials
    ? { ...resolvedCredentials, ...secrets }
    : secrets;

  // Build experimental connectors manifest from agent compose
  const experimentalConnectors = buildExperimentalConnectors(agentCompose);

  // Build final execution context
  return {
    runtimeScope,
    context: {
      runId: params.runId,
      userId: params.userId,
      agentComposeVersionId,
      agentCompose,
      prompt: params.prompt,
      vars,
      secrets: mergedSecrets,
      secretNames,
      sandboxToken: params.sandboxToken,
      artifactName,
      artifactVersion,
      memoryName,
      volumeVersions,
      environment,
      userTimezone,
      experimentalConnectors: experimentalConnectors ?? undefined,
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
      resolveSourceAndScope: resolveEnd - resolveStart,
      resolveCredentials: resolveCredentialsEnd - resolveCredentialsStart,
    },
  };
}
