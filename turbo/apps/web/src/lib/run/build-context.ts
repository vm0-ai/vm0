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
  type ExperimentalServices,
  type ConnectorType,
  type ModelProviderType,
  type ModelProviderFramework,
} from "@vm0/core";
import { agentComposeVersions } from "../../db/schema/agent-compose";
import type { AgentComposeYaml } from "../../types/agent-compose";
import { badRequest, notFound } from "../errors";
import { getOrgData } from "../scope/org-cache-service";
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
import { getDefaultOrg } from "../scope/org-member-service";
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
  secretValue: string | undefined,
  selectedModel: string | undefined,
  secretsMap?: Record<string, string>,
): Record<string, string> {
  const mapping = getEnvironmentMapping(providerType);

  if (!mapping) {
    // No mapping - return secret directly under its natural name
    const secretName = getSecretNameForType(providerType);
    if (!secretName || !secretValue) {
      // Multi-auth providers should have environmentMapping, this shouldn't happen
      return {};
    }
    return { [secretName]: secretValue };
  }

  // Resolve model: use selected or fall back to default
  const model = selectedModel || getDefaultModel(providerType);

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value === "$secret") {
      // Single secret value
      if (secretValue) {
        result[key] = secretValue;
      }
    } else if (value === "$model") {
      if (model) {
        result[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      // Multi-auth: lookup secret from map
      const lookupName = value.slice("$secrets.".length);
      const lookupValue = secretsMap?.[lookupName];
      if (lookupValue) {
        result[key] = lookupValue;
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
 * Result of model provider secret resolution
 */
interface ModelProviderSecretResult {
  secrets: Record<string, string> | undefined;
  /** Environment variables to inject (may be multiple for providers with mapping) */
  injectedEnvVars: Record<string, string> | undefined;
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
    return { secrets, injectedEnvVars: undefined };
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
      return { secrets, injectedEnvVars: undefined };
    }

    // Get secret names for this auth method
    const secretNames = getSecretNamesForAuthMethod(providerType, authMethod);
    if (!secretNames || secretNames.length === 0) {
      log.debug(`No secret names found for ${providerType}/${authMethod}`);
      return { secrets, injectedEnvVars: undefined };
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
      return { secrets, injectedEnvVars: undefined };
    }

    // Store secrets for masking
    secrets = secrets || {};
    Object.assign(secrets, secretsMap);

    // Resolve environment mapping with secrets map
    const injectedEnvVars = resolveEnvironmentMapping(
      providerType,
      undefined, // No single secret for multi-auth
      selectedModel,
      secretsMap,
    );

    log.debug(
      `Resolved multi-auth model provider env vars: ${Object.keys(injectedEnvVars).join(", ")}`,
    );

    return { secrets, injectedEnvVars };
  }

  // Handle single-secret providers
  const secretName = getSecretNameForType(providerType);
  if (!secretName) {
    return { secrets, injectedEnvVars: undefined };
  }

  const secretValue = await getSecretValue(
    orgId,
    userId,
    secretName,
    "model-provider",
  );

  if (!secretValue) {
    return { secrets, injectedEnvVars: undefined };
  }

  // Store secret in secrets map for masking
  secrets = secrets || {};
  secrets[secretName] = secretValue;

  // Resolve environment mapping (handles $secret and $model substitution)
  const injectedEnvVars = resolveEnvironmentMapping(
    providerType,
    secretValue,
    selectedModel,
  );

  log.debug(
    `Resolved model provider env vars: ${Object.keys(injectedEnvVars).join(", ")}`,
  );

  return { secrets, injectedEnvVars };
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
  orgId: string,
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
      orgId,
      userId,
      accessTokenSecret,
      result.accessToken,
    );
    if (result.refreshToken) {
      await upsertConnectorSecret(
        orgId,
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
 * Result of connector secret resolution
 */
interface ConnectorSecretResult {
  /** All raw connector secrets (for masking and direct secret reference resolution) */
  connectorSecrets: Record<string, string> | undefined;
  /** Environment variables mapped from OAuth connectors via environmentMapping */
  injectedEnvVars: Record<string, string> | undefined;
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
    };
  }

  const connectorSecrets = await getSecretValues(orgId, userId, "connector");
  if (Object.keys(connectorSecrets).length === 0) {
    return {
      connectorSecrets: undefined,
      injectedEnvVars: undefined,
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

  return {
    connectorSecrets,
    injectedEnvVars: allInjectedEnvVars,
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
  const grouped = extractAndGroupVariables(composeEnvironment);

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
  // Caller-resolved scope slug and orgId for secret/variable/storage resolution.
  // When provided, used for both secrets and storage (artifacts/memory).
  // When not provided, resolved via getDefaultOrg fallback.
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
  runId: string,
  checkEnv: boolean | undefined,
  userId: string,
): Promise<{
  secrets: Record<string, string> | undefined;
  platformSecrets: Record<string, string> | undefined;
  environment: Record<string, string> | undefined;
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

  // Merge platform secrets from all sources for masking.
  // All raw connector secrets are included (both OAuth intermediate and api-token target names).
  const hasPlatformSecrets =
    dbSecrets ||
    modelProviderResult.secrets ||
    connectorResult.connectorSecrets;
  const platformSecrets: Record<string, string> | undefined = hasPlatformSecrets
    ? {
        ...dbSecrets,
        ...modelProviderResult.secrets,
        ...connectorResult.connectorSecrets,
      }
    : undefined;

  // Merge secrets: DB user secrets + CLI secrets (CLI takes priority)
  let secrets = mergeSecrets(dbSecrets, cliSecrets);

  // Merge connector secrets into secrets pool for explicit ${{ secrets.* }} references only.
  // Two sources: raw connectorSecrets (api-token names like FIGMA_TOKEN) and
  // injectedEnvVars (OAuth-mapped names like FIGMA_TOKEN from $secrets.FIGMA_ACCESS_TOKEN).
  // injectedEnvVars overrides connectorSecrets so OAuth-mapped names take precedence.
  const connectorEnvPool =
    connectorResult.connectorSecrets || connectorResult.injectedEnvVars
      ? {
          ...connectorResult.connectorSecrets,
          ...connectorResult.injectedEnvVars,
        }
      : undefined;
  secrets = mergeConnectorSecretsForReferences(
    firstAgent?.environment,
    secrets,
    connectorEnvPool,
  );

  const modelProviderEnvVars = modelProviderResult.injectedEnvVars;

  // Expand environment variables from compose config.
  const { environment: expandedEnvironment } = expandEnvironmentFromCompose(
    agentCompose,
    mergedVars,
    secrets,
    checkEnv,
  );

  // Auto-inject model provider env vars into environment
  const environment = autoInjectEnvVarsToEnvironment(
    expandedEnvironment,
    modelProviderEnvVars,
    "model provider",
  );

  return { secrets, platformSecrets, environment };
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
 * Resolve the Runtime Scope for this execution.
 *
 * The Runtime Scope (orgId + userId) determines secrets, variables,
 * connectors, model providers, artifacts, and memories.
 * See docs/resource-model.md for the full resource model.
 *
 * When params.orgId is not provided, the user's default scope is used.
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
  // No explicit scope — default scope is used
  const { org } = await getDefaultOrg(params.userId);
  return {
    runtimeClerkOrgId: org.orgId,
    pendingRuntimeScope: {
      slug: org.slug,
      orgId: org.orgId,
    },
  };
}

interface BuildContextTimings {
  resolveSourceAndScope: number;
  resolveSecrets: number;
}

interface BuildContextResult {
  context: ExecutionContext;
  runtimeOrg: RuntimeOrg;
  timings: BuildContextTimings;
}

/**
 * Build ExperimentalServices manifest from agent compose's expanded experimental_services.
 * Returns null if no services are declared.
 *
 * Reads pre-expanded ExpandedServiceConfig objects (resolved at compose time)
 * and flattens apis to one entry per base URL with auth headers (for runner-side matching).
 *
 * Placeholder env var injection is handled by expandEnvironmentFromCompose.
 */
function buildExperimentalServices(
  agentCompose: unknown,
): ExperimentalServices | null {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return null;

  const firstAgent = Object.values(compose.agents)[0];
  const services = firstAgent?.experimental_services;
  if (!services || services.length === 0) return null;

  const entries: { base: string; auth: { headers: Record<string, string> } }[] =
    [];

  for (const service of services) {
    for (const serviceApi of service.apis) {
      entries.push({ base: serviceApi.base, auth: serviceApi.auth });
    }
  }

  return { apis: entries };
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

  // Step 1: Resolve source and scopes in parallel (independent operations).
  // resolveSource loads checkpoint/session/conversation data.
  // resolveOrgs resolves the runtime scope for secrets and storage.
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
      params.runId,
      params.checkEnv,
      params.userId,
    ),
    params.userId
      ? getUserPreferences(runtimeClerkOrgId, params.userId)
      : Promise.resolve(null),
    Promise.resolve(pendingRuntimeScope),
  ]);
  const resolveSecretsEnd = Date.now();

  const {
    secrets: resolvedSecrets,
    platformSecrets,
    environment,
  } = secretsResult;
  const userTimezone = userPrefs?.timezone ?? undefined;

  // Step 5: Merge platform secrets into secrets for client-side log masking
  // Platform secrets are server-stored user-level secrets and must be masked like CLI secrets
  // Priority: CLI --secrets > platform secrets
  const mergedSecrets = platformSecrets
    ? { ...platformSecrets, ...resolvedSecrets }
    : resolvedSecrets;

  // Build experimental services manifest (base + auth entries for the runner)
  const experimentalServices =
    buildExperimentalServices(agentCompose) ?? undefined;

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
      secrets: mergedSecrets,
      sandboxToken: params.sandboxToken,
      artifactName,
      artifactVersion,
      memoryName,
      volumeVersions,
      environment,
      userTimezone,
      experimentalServices,
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
      resolveSecrets: resolveSecretsEnd - resolveSecretsStart,
    },
  };
}
