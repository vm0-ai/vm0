import { eq } from "drizzle-orm";
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
  connectorTypeSchema,
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
  type ModelProviderFramework,
} from "@vm0/core";
import { agentComposeVersions } from "../../db/schema/agent-compose";
import { badRequest, notFound } from "../errors";
import { logger } from "../logger";
import type { ExecutionContext, ResumeSession } from "./types";
import type { ArtifactSnapshot } from "../checkpoint/types";
import {
  resolveCheckpoint,
  resolveSession,
  resolveDirectConversation,
  type ConversationResolution,
} from "./resolvers";
import { expandEnvironmentFromCompose } from "./environment";
import { getUserScopeByClerkId } from "../scope/scope-service";
import { getSecretValue, getSecretValues } from "../secret/secret-service";
import { getVariableValues } from "../variable/variable-service";
import { getDefaultModelProvider } from "../model-provider/model-provider-service";
import { connectors } from "../../db/schema/connector";
import { refreshNotionToken } from "../connector/providers/notion";
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
 * Resolve model provider type from explicit value or default
 */
async function resolveProviderType(
  scopeId: string,
  framework: ModelProviderFramework,
  explicitModelProvider?: string,
): Promise<ModelProviderType> {
  if (explicitModelProvider) {
    // Validate that the specified model provider type is valid
    if (!(explicitModelProvider in MODEL_PROVIDER_TYPES)) {
      throw badRequest(
        `Unknown model provider type "${explicitModelProvider}". Valid types: ${Object.keys(MODEL_PROVIDER_TYPES).join(", ")}`,
      );
    }
    return explicitModelProvider as ModelProviderType;
  }

  // Get default provider for framework
  const defaultProvider = await getDefaultModelProvider(scopeId, framework);
  if (!defaultProvider?.type) {
    throw badRequest(
      "No model provider configured. " +
        "Run 'vm0 model-provider setup' to configure one, " +
        "or add environment variables to your vm0.yaml.",
    );
  }
  return defaultProvider.type;
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
  userId: string,
  framework: string,
  hasExplicitModelProviderConfig: boolean,
  existingCredentials: Record<string, string> | undefined,
  explicitModelProvider?: string,
): Promise<ModelProviderCredentialResult> {
  let credentials = existingCredentials;

  // Skip if explicit model provider config exists or framework doesn't use model providers
  if (
    hasExplicitModelProviderConfig ||
    (framework !== "claude-code" && framework !== "codex")
  ) {
    return { credentials, injectedEnvVars: undefined };
  }

  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    return { credentials, injectedEnvVars: undefined };
  }

  // Resolve model provider type (explicit or default)
  const providerType = await resolveProviderType(
    userScope.id,
    framework as ModelProviderFramework,
    explicitModelProvider,
  );

  // Validate framework compatibility
  const providerFramework = getFrameworkForType(providerType);
  if (providerFramework !== framework) {
    throw badRequest(
      `Model provider "${providerType}" is not compatible with framework "${framework}". ` +
        `This provider is for "${providerFramework}" agents.`,
    );
  }

  // Get selected model from default provider if available
  const defaultProvider = await getDefaultModelProvider(
    userScope.id,
    framework as ModelProviderFramework,
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
      userScope.id,
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
    userScope.id,
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
 * Refresh Notion access token using the stored refresh token.
 * Updates both NOTION_ACCESS_TOKEN and NOTION_REFRESH_TOKEN in the database
 * and returns the new access token for immediate use.
 *
 * Returns null if refresh token is unavailable or refresh fails
 * (caller should fall back to using the existing access token).
 */
async function refreshNotionAccessToken(
  userId: string,
  connectorSecrets: Record<string, string>,
): Promise<string | null> {
  const currentRefreshToken = connectorSecrets["NOTION_REFRESH_TOKEN"];
  if (!currentRefreshToken) {
    log.debug("No Notion refresh token available, skipping token refresh");
    return null;
  }

  const env = globalThis.services.env;
  const clientId = env.NOTION_OAUTH_CLIENT_ID;
  const clientSecret = env.NOTION_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    log.debug(
      "Notion OAuth credentials not configured, skipping token refresh",
    );
    return null;
  }

  try {
    const result = await refreshNotionToken(
      clientId,
      clientSecret,
      currentRefreshToken,
    );

    // Persist new tokens to database
    await upsertConnectorSecret(
      userId,
      "NOTION_ACCESS_TOKEN",
      result.accessToken,
    );
    if (result.refreshToken) {
      await upsertConnectorSecret(
        userId,
        "NOTION_REFRESH_TOKEN",
        result.refreshToken,
      );
    }

    // Update in-memory secrets map so subsequent mapping uses fresh token
    connectorSecrets["NOTION_ACCESS_TOKEN"] = result.accessToken;
    if (result.refreshToken) {
      connectorSecrets["NOTION_REFRESH_TOKEN"] = result.refreshToken;
    }

    log.debug("Notion access token refreshed successfully");
    return result.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn(`Notion token refresh failed: ${message}`);
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
 *
 * Resolves scope once and queries both connectors and secrets directly,
 * avoiding redundant getUserScopeByClerkId calls.
 */
async function resolveConnectorCredentials(
  userId: string,
  existingCredentials: Record<string, string> | undefined,
): Promise<ConnectorCredentialResult> {
  let credentials = existingCredentials;

  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    return { credentials, injectedEnvVars: undefined };
  }

  // Query connected connectors directly (only need the type for environmentMapping)
  const userConnectors = await globalThis.services.db
    .select({ type: connectors.type })
    .from(connectors)
    .where(eq(connectors.scopeId, userScope.id));

  if (userConnectors.length === 0) {
    return { credentials, injectedEnvVars: undefined };
  }

  const connectorSecrets = await getSecretValues(userScope.id, "connector");
  if (Object.keys(connectorSecrets).length === 0) {
    return { credentials, injectedEnvVars: undefined };
  }

  const allInjectedEnvVars: Record<string, string> = {};

  for (const connector of userConnectors) {
    const connectorType = connectorTypeSchema.safeParse(connector.type);
    if (!connectorType.success) {
      continue;
    }

    // Refresh Notion token before resolving environment mapping
    if (connectorType.data === "notion") {
      await refreshNotionAccessToken(userId, connectorSecrets);
    }

    const mapping = getConnectorEnvironmentMapping(connectorType.data);

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

  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    return undefined;
  }

  // Only fetch user secrets for variable expansion (model-provider secrets are isolated)
  const userSecrets = await getSecretValues(userScope.id, "user");
  log.debug(
    `Fetched ${Object.keys(userSecrets).length} user secret(s) from scope ${userScope.slug}`,
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
  userId: string,
  cliVars: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    return cliVars;
  }

  const storedVars = await getVariableValues(userScope.id);
  if (Object.keys(storedVars).length === 0) {
    return cliVars;
  }

  log.debug(
    `Fetched ${Object.keys(storedVars).length} stored variable(s) from scope ${userScope.slug}`,
  );

  // Merge: CLI vars override stored vars
  const merged = { ...storedVars, ...cliVars };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Parameters for building execution context
 */
export interface BuildContextParams {
  // Shortcuts (mutually exclusive)
  checkpointId?: string;
  sessionId?: string;
  // Base parameters
  agentComposeVersionId?: string;
  conversationId?: string;
  artifactName?: string;
  artifactVersion?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  volumeVersions?: Record<string, string>;
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
  userId: string,
  agentCompose: unknown,
  firstAgent:
    | { environment?: Record<string, string>; framework?: string }
    | undefined,
  vars: Record<string, string> | undefined,
  cliSecrets: Record<string, string> | undefined,
  modelProvider: string | undefined,
  runId: string,
  checkEnv: boolean | undefined,
): Promise<{
  secrets: Record<string, string> | undefined;
  credentials: Record<string, string> | undefined;
  environment: Record<string, string> | undefined;
}> {
  // Fetch secrets/credentials referenced in environment
  const dbSecrets = await fetchReferencedCredentials(
    userId,
    firstAgent?.environment,
  );

  // Merge DB secrets with CLI secrets (CLI takes priority)
  let secrets = mergeSecrets(dbSecrets, cliSecrets);

  // credentials is used for backwards compatibility with credentials.* syntax
  let credentials: Record<string, string> | undefined = dbSecrets;

  // Model provider credential injection
  const hasExplicitModelProviderConfig = MODEL_PROVIDER_ENV_VARS.some(
    (v) => firstAgent?.environment?.[v] !== undefined,
  );
  const framework = firstAgent?.framework || "claude-code";

  const modelProviderResult = await resolveModelProviderCredential(
    userId,
    framework,
    hasExplicitModelProviderConfig,
    credentials,
    modelProvider,
  );
  credentials = modelProviderResult.credentials;
  const modelProviderEnvVars = modelProviderResult.injectedEnvVars;

  // Resolve connector credentials (GH_TOKEN, GITHUB_TOKEN, etc.)
  const connectorResult = await resolveConnectorCredentials(
    userId,
    credentials,
  );
  credentials = connectorResult.credentials;
  const connectorEnvVars = connectorResult.injectedEnvVars;

  // Merge connector secrets into secrets pool for explicit ${{ secrets.* }} references only.
  // Connector secrets only fill gaps — user/CLI secrets take precedence.
  secrets = mergeConnectorSecretsForReferences(
    firstAgent?.environment,
    secrets,
    connectorEnvVars,
  );

  // Fetch server-stored variables and merge with CLI vars
  const mergedVars = await fetchAndMergeVariables(userId, vars);

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
 * Build unified execution context from various parameter sources
 * Supports: new run, checkpoint resume, session continue
 *
 * Parameter expansion:
 * - checkpointId: Expands to checkpoint snapshot (config, conversation, artifact, volumes)
 * - sessionId: Expands to session data (config, conversation, artifact=latest)
 * - Explicit parameters override expanded values
 *
 * @param params Unified run parameters
 * @returns Execution context for executors
 */
export async function buildExecutionContext(
  params: BuildContextParams,
): Promise<ExecutionContext> {
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
  let volumeVersions: Record<string, string> | undefined =
    params.volumeVersions;
  let resumeSession: ResumeSession | undefined;
  let resumeArtifact: ArtifactSnapshot | undefined;

  // Step 1: Resolve to conversation (unified path for checkpoint/session/direct)
  const resolution = await resolveSource(params);

  // Step 2: Apply resolution defaults and build resumeSession (unified path)
  // Note: secrets are NEVER stored - caller must always provide fresh secrets via params
  if (resolution) {
    // Apply defaults (params override resolution values)
    agentComposeVersionId =
      agentComposeVersionId || resolution.agentComposeVersionId;
    agentCompose = resolution.agentCompose;
    artifactName = artifactName || resolution.artifactName;
    artifactVersion = artifactVersion || resolution.artifactVersion;
    vars = vars || resolution.vars;
    // secrets from params only - resolution only has secretNames for validation
    // Get secretNames from resolution (stored for validation/error messages)
    secretNames = resolution.secretNames;
    volumeVersions = volumeVersions || resolution.volumeVersions;

    // Build resumeSession from resolution (single place!)
    resumeSession = {
      sessionId: resolution.conversationData.cliAgentSessionId,
      sessionHistory: resolution.conversationData.cliAgentSessionHistory,
      workingDir: resolution.workingDir,
    };

    // Build resumeArtifact if applicable
    if (resolution.buildResumeArtifact && artifactName) {
      resumeArtifact = {
        artifactName,
        artifactVersion: artifactVersion || "latest",
      };
    }

    log.debug(
      `Resolution applied: artifact=${artifactName}@${artifactVersion}`,
    );
  }
  // Step 3: New run - load agent compose version if agentComposeVersionId provided (no conversation)
  else if (agentComposeVersionId) {
    agentCompose = await loadAgentComposeForNewRun(agentComposeVersionId);

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

  // Step 4: Fetch secrets/credentials from user's scope and merge with CLI secrets
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

  // Step 4: Resolve all credentials and secrets, then expand environment
  const {
    secrets: resolvedSecrets,
    credentials: resolvedCredentials,
    environment,
  } = await resolveCredentialsAndEnvironment(
    params.userId,
    agentCompose,
    firstAgent,
    vars,
    params.secrets,
    params.modelProvider,
    params.runId,
    params.checkEnv,
  );
  secrets = resolvedSecrets;

  // Step 5: Merge credentials into secrets for client-side log masking
  // Credentials are server-stored user-level secrets and must be masked like CLI secrets
  // Priority: CLI --secrets > credentials (platform-stored)
  const mergedSecrets = resolvedCredentials
    ? { ...resolvedCredentials, ...secrets }
    : secrets;

  // Build final execution context
  return {
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
    volumeVersions,
    environment,
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
  };
}
