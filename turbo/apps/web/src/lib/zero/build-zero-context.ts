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
  getModelProviderFirewall,
  areProvidersCompatible,
  getVm0ConcreteProviderType,
  getVm0Vendor,
  type Firewalls,
  type ExpandedFirewallConfig,
  type ConnectorType,
  type ModelProviderType,
  type ModelProviderFramework,
  type FirewallPolicies,
  getConnectorFirewall,
  isFirewallConnectorType,
  resolveFirewallBaseUrlVars,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import {
  agentComposeVersions,
  agentComposes,
} from "../../db/schema/agent-compose";
import { getAgentSessionWithConversation } from "../agent-session";
import { checkpoints } from "../../db/schema/checkpoint";
import { agentRuns } from "../../db/schema/agent-run";
import { zeroRuns } from "../../db/schema/zero-run";
import {
  badRequest,
  notFound,
  noModelProvider,
  providerIncompatible,
} from "../errors";
import { logger } from "../logger";
import type { ExecutionContext, ResumeSession } from "../run/types";
import type { ArtifactSnapshot } from "../checkpoint/types";
import {
  resolveCheckpoint,
  resolveSession,
  resolveDirectConversation,
  type ConversationResolution,
} from "../run/resolvers";
import { expandEnvironmentFromCompose } from "../run/environment";
import { getUserPreferences } from "./user/user-preferences-service";
import { getSecretValue, getSecretValues } from "../secret/secret-service";
import { getVariableValues } from "../variable/variable-service";
import { getOrgDefaultModelProvider } from "../model-provider/model-provider-service";
import { getVm0ApiKey } from "../vm0-key/vm0-key-service";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { connectors } from "../../db/schema/connector";
import { PROVIDER_HANDLERS } from "../connector/provider-registry";
import {
  getApiTokenConnectorTypes,
  refreshConnectorAccessToken,
} from "../connector/connector-service";

const log = logger("zero:build-context");

/**
 * Model provider environment variables that indicate explicit configuration.
 * Includes both model-provider supported vars and alternative auth methods.
 */
export const MODEL_PROVIDER_ENV_VARS = [
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
  defaultProvider: Awaited<ReturnType<typeof getOrgDefaultModelProvider>>,
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
    throw noModelProvider();
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
  /** The resolved model provider type (e.g. "anthropic", "vercel-ai-gateway").
   *  Undefined when provider resolution was skipped (explicit env vars or non-claude-code). */
  resolvedModelProvider: ModelProviderType | undefined;
  /** For meta-providers like "vm0", the concrete provider type resolved at build time.
   *  Used for firewall lookup instead of the meta-provider type. */
  concreteProviderType?: ModelProviderType;
  /** The logical model name selected by the user (e.g. "claude-sonnet-4.6").
   *  Used for credit usage billing. */
  selectedModel?: string;
}

/**
 * Resolve VM0 managed provider: map selected model to concrete provider,
 * fetch API key from pool, and resolve environment mapping.
 */
async function resolveVm0Provider(
  selectedModel: string,
): Promise<ModelProviderSecretResult> {
  const concreteType = getVm0ConcreteProviderType(selectedModel);
  const vendor = getVm0Vendor(selectedModel);
  const poolKey = await getVm0ApiKey(vendor);
  if (!poolKey) {
    throw badRequest(`No API key available for vendor "${vendor}"`);
  }
  const concreteSecretName = getSecretNameForType(concreteType);
  if (!concreteSecretName) {
    throw badRequest(`Concrete provider "${concreteType}" has no secret name`);
  }
  const secrets = { [concreteSecretName]: poolKey.apiKey };
  const injectedEnvironment = resolveEnvironmentMapping(
    concreteType,
    concreteSecretName,
    poolKey.model,
  );

  log.debug(
    `Resolved VM0 model provider: ${selectedModel} → ${concreteType} (vendor: ${vendor})`,
  );

  return {
    secrets,
    injectedEnvironment,
    resolvedModelProvider: "vm0",
    concreteProviderType: concreteType,
    selectedModel,
  };
}

/**
 * Resolve and inject model provider secret if needed
 * Only injects if no explicit model provider config in compose environment
 *
 * For providers with environment mapping (e.g., moonshot), resolves all env vars
 */
async function resolveModelProviderSecrets(
  orgId: string,
  framework: string,
  hasExplicitModelProviderConfig: boolean,
  explicitModelProvider?: string,
): Promise<ModelProviderSecretResult> {
  let secrets: Record<string, string> | undefined;

  // Skip if explicit model provider config exists or framework doesn't use model providers
  if (hasExplicitModelProviderConfig || framework !== "claude-code") {
    return {
      secrets,
      injectedEnvironment: undefined,
      resolvedModelProvider: undefined,
    };
  }

  // Fetch org-level default provider
  const defaultProvider = await getOrgDefaultModelProvider(
    orgId,
    framework as ModelProviderFramework,
  );

  const secretUserId = ORG_SENTINEL_USER_ID;

  const providerType = resolveProviderType(
    framework,
    defaultProvider,
    explicitModelProvider,
  );
  const selectedModel = defaultProvider?.selectedModel ?? undefined;

  // Handle VM0 managed provider (meta-provider resolution)
  if (providerType === "vm0") {
    if (!selectedModel) {
      throw badRequest("VM0 provider requires a selected model");
    }
    return resolveVm0Provider(selectedModel);
  }

  // Handle multi-auth providers (like aws-bedrock)
  if (hasAuthMethods(providerType)) {
    const authMethod = defaultProvider?.authMethod;
    if (!authMethod) {
      log.debug(
        `Multi-auth provider ${providerType} has no auth method configured`,
      );
      return {
        secrets,
        injectedEnvironment: undefined,
        resolvedModelProvider: providerType,
        selectedModel,
      };
    }

    // Get secret names for this auth method
    const secretNames = getSecretNamesForAuthMethod(providerType, authMethod);
    if (!secretNames || secretNames.length === 0) {
      log.debug(`No secret names found for ${providerType}/${authMethod}`);
      return {
        secrets,
        injectedEnvironment: undefined,
        resolvedModelProvider: providerType,
        selectedModel,
      };
    }

    // Fetch all model-provider secrets by name (scoped to provider owner)
    const allSecretValues = await getSecretValues(
      orgId,
      secretUserId,
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
      return {
        secrets,
        injectedEnvironment: undefined,
        resolvedModelProvider: providerType,
        selectedModel,
      };
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

    return {
      secrets,
      injectedEnvironment,
      resolvedModelProvider: providerType,
      selectedModel,
    };
  }

  // Handle single-secret providers
  const secretName = getSecretNameForType(providerType);
  if (!secretName) {
    return {
      secrets,
      injectedEnvironment: undefined,
      resolvedModelProvider: providerType,
      selectedModel,
    };
  }

  const secretValue = await getSecretValue(
    orgId,
    secretUserId,
    secretName,
    "model-provider",
  );

  if (!secretValue) {
    return {
      secrets,
      injectedEnvironment: undefined,
      resolvedModelProvider: providerType,
      selectedModel,
    };
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

  return {
    secrets,
    injectedEnvironment,
    resolvedModelProvider: providerType,
    selectedModel,
  };
}

/**
 * Result of connector secret resolution
 */
interface OauthConnectorSecretResult {
  /** OAuth connector secrets resolved from environmentMapping (e.g. { GITHUB_TOKEN: "ghp_..." }) */
  resolvedSecrets: Record<string, string> | undefined;
  /** Maps secret names to connector types for refresh-capable OAuth connectors */
  secretConnectorMap: Record<string, string> | undefined;
  /** Validated OAuth connector types from DB */
  connectorTypes: ConnectorType[];
}

/**
 * Resolve and inject OAuth connector secrets.
 * For each connected OAuth connector, resolves its environmentMapping to produce
 * environment variables (e.g., GH_TOKEN, GITHUB_TOKEN for GitHub connector).
 */
async function resolveOauthConnectorSecrets(
  orgId: string,
  userId: string,
  allowedTypes?: ConnectorType[],
): Promise<OauthConnectorSecretResult> {
  const db = globalThis.services.db;

  const userConnectors = await db
    .select({ type: connectors.type, authMethod: connectors.authMethod })
    .from(connectors)
    .where(and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)));

  if (userConnectors.length === 0) {
    return {
      resolvedSecrets: undefined,
      secretConnectorMap: undefined,
      connectorTypes: [],
    };
  }

  const connectorSecrets = await getSecretValues(orgId, userId, "connector");
  if (Object.keys(connectorSecrets).length === 0) {
    return {
      resolvedSecrets: undefined,
      secretConnectorMap: undefined,
      connectorTypes: [],
    };
  }

  // Parse connector types upfront (OAuth connectors from DB)
  const validConnectors = userConnectors
    .map((c) => {
      const parsed = connectorTypeSchema.safeParse(c.type);
      return parsed.success
        ? { type: parsed.data, authMethod: c.authMethod }
        : null;
    })
    .filter((c): c is { type: ConnectorType; authMethod: string } => {
      return c !== null;
    });

  // Filter to only allowed connector types when a permission list is provided.
  const allowedConnectors = allowedTypes
    ? validConnectors.filter(({ type }) => {
        return allowedTypes.includes(type);
      })
    : validConnectors;
  // Refresh OAuth tokens in parallel.
  // Safe: each connector writes to distinct keys in connectorSecrets (e.g. github_access_token
  // vs slack_access_token), so concurrent mutations don't conflict.
  await Promise.all(
    allowedConnectors
      .filter(({ type }) => {
        const handler =
          PROVIDER_HANDLERS[type as keyof typeof PROVIDER_HANDLERS];
        return handler?.refreshToken;
      })
      .map(({ type }) => {
        return refreshConnectorAccessToken(
          type,
          orgId,
          userId,
          connectorSecrets,
        );
      }),
  );

  // Resolve environment mappings from connectors.
  const allInjectedEnvVars: Record<string, string> = {};

  for (const { type: connectorType } of allowedConnectors) {
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
  // Maps secret/env-var name → connector type so the auth endpoint can refresh
  // expired tokens at runtime.  Both the raw secret name (e.g.
  // GOOGLE_CALENDAR_ACCESS_TOKEN) and the mapped env var name (e.g.
  // GOOGLE_CALENDAR_TOKEN) are included because firewall templates may
  // reference either form.
  const secretConnectorMap: Record<string, string> = {};
  for (const { type } of allowedConnectors) {
    if (!(type in PROVIDER_HANDLERS)) continue;
    const handler = PROVIDER_HANDLERS[type as keyof typeof PROVIDER_HANDLERS];
    if (!handler.refreshToken) continue;

    const secretName = handler.getSecretName();
    secretConnectorMap[secretName] = type;

    const mapping = getConnectorEnvironmentMapping(type);
    for (const [envVar, valueRef] of Object.entries(mapping)) {
      if (valueRef === `$secrets.${secretName}`) {
        secretConnectorMap[envVar] = type;
      }
    }
  }

  return {
    resolvedSecrets: allInjectedEnvVars,
    secretConnectorMap:
      Object.keys(secretConnectorMap).length > 0
        ? secretConnectorMap
        : undefined,
    connectorTypes: allowedConnectors.map((c) => {
      return c.type;
    }),
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

  const referencedNames = grouped.secrets.map((r) => {
    return r.name;
  });
  log.debug(`Secrets referenced in environment: ${referencedNames.join(", ")}`);

  // Fetch org and user secrets in parallel, merge with user > org priority
  const [orgSecrets, userSecrets] = await Promise.all([
    getSecretValues(orgId, ORG_SENTINEL_USER_ID, "user"),
    getSecretValues(orgId, userId, "user"),
  ]);
  const mergedSecrets = { ...orgSecrets, ...userSecrets };
  log.debug(
    `Fetched ${Object.keys(mergedSecrets).length} user secret(s) for org ${orgId}`,
  );
  return mergedSecrets;
}

/**
 * Filter dbSecrets to remove env vars that belong to connectors not in allowedConnectorTypes.
 * Custom user secrets (not owned by any connector) pass through unfiltered.
 * When allowedConnectorTypes is undefined (e.g. CLI runs), no filtering is applied.
 */
function filterDbSecretsByConnectorPermissions(
  dbSecrets: Record<string, string> | undefined,
  allApiTokenTypes: ConnectorType[],
  allowedConnectorTypes: ConnectorType[] | undefined,
): Record<string, string> | undefined {
  if (!dbSecrets || !allowedConnectorTypes) {
    return dbSecrets;
  }

  // Compute the set of env var names belonging to ALL api-token connectors the user has.
  const allConnectorEnvVars = getConnectorProvidedSecretNames(allApiTokenTypes);
  // Compute the set of env var names belonging to ALLOWED connectors only.
  const allowedApiTokenTypes = allApiTokenTypes.filter((t) => {
    return allowedConnectorTypes.includes(t);
  });
  const allowedEnvVars = getConnectorProvidedSecretNames(allowedApiTokenTypes);
  // Disallowed = belongs to a connector but not an allowed one.
  const disallowed = new Set(
    [...allConnectorEnvVars].filter((name) => {
      return !allowedEnvVars.has(name);
    }),
  );

  if (disallowed.size === 0) {
    return dbSecrets;
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(dbSecrets)) {
    if (!disallowed.has(key)) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
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
  // Fetch org and user variables in parallel, merge with user > org priority
  const [orgVars, userVars] = await Promise.all([
    getVariableValues(orgId, ORG_SENTINEL_USER_ID),
    getVariableValues(orgId, userId),
  ]);
  const storedVars = { ...orgVars, ...userVars };
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
  // Model provider for automatic secret injection
  modelProvider?: string;
  // API start time for E2E timing metrics
  apiStartTime?: number;
  // Per-permission firewall policies from zero agent configuration.
  firewallPolicies?: FirewallPolicies;
  // Caller-resolved org context for secret/variable/storage resolution.
  orgId: string;
  // Connector types the user has permitted for this agent run. When set, only
  // these connector types will have their secrets injected at runtime.
  allowedConnectorTypes?: ConnectorType[];
}

/**
 * Resolve source based on params
 * Returns ConversationResolution if a source is found, null for new runs
 */
async function resolveSource(
  params: BuildZeroContextParams,
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
): Promise<{
  secrets: Record<string, string> | undefined;
  environment: Record<string, string> | undefined;
  secretConnectorMap: Record<string, string> | undefined;
  resolvedModelProvider: ModelProviderType | undefined;
  modelProviderFirewall: ExpandedFirewallConfig | undefined;
  selectedModel: string | undefined;
  connectorFirewalls: ExpandedFirewallConfig[];
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
  ] = await Promise.all([
    fetchReferencedSecrets(orgId, userId, firstAgent?.environment),
    resolveModelProviderSecrets(
      orgId,
      framework,
      hasExplicitModelProviderConfig,
      modelProvider,
    ),
    resolveOauthConnectorSecrets(orgId, userId, allowedConnectorTypes),
    getApiTokenConnectorTypes(orgId, userId),
    fetchAndMergeVariables(orgId, userId, vars),
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
  const hasSecrets =
    oauthResult.resolvedSecrets ||
    modelProviderResult.secrets ||
    filteredDbSecrets ||
    cliSecrets;
  const secrets: Record<string, string> | undefined = hasSecrets
    ? {
        ...oauthResult.resolvedSecrets, // connector env mappings (e.g. GITHUB_TOKEN)
        ...modelProviderResult.secrets, // model provider
        ...filteredDbSecrets, // DB user secrets (connector secrets filtered)
        ...cliSecrets, // highest: CLI --secrets
      }
    : undefined;

  // Filter secretConnectorMap: remove keys overridden by higher-priority sources.
  const secretConnectorMap = filterSecretConnectorMap(
    oauthResult.secretConnectorMap,
    [modelProviderResult.secrets, dbSecrets, cliSecrets],
  );

  // Auto-generate firewall entry for model provider (if applicable).
  // For meta-providers like "vm0", use the concrete provider type for firewall lookup.
  const modelProviderFirewallType =
    modelProviderResult.concreteProviderType ??
    modelProviderResult.resolvedModelProvider;
  const modelProviderFirewall = modelProviderFirewallType
    ? getModelProviderFirewall(modelProviderFirewallType)
    : undefined;

  // Build connector firewall configs for placeholder injection.
  // connectorFirewalls configs carry `placeholders` (custom placeholder values),
  // which expandEnvironmentFromCompose needs to replace secrets with placeholders.
  const connectorFirewallConfigs: ExpandedFirewallConfig[] = connectorTypes
    .filter(isFirewallConnectorType)
    .map((type) => {
      return {
        ...getConnectorFirewall(type),
        ref: type,
      };
    });

  // Expand environment variables from compose config.
  // All firewalls (model provider, connector) are passed via the `firewalls` param
  // for unified placeholder injection. Compose content no longer stores firewalls.
  const { environment } = expandEnvironmentFromCompose(
    agentCompose,
    mergedVars,
    secrets,
    modelProviderResult.injectedEnvironment,
    [
      ...(modelProviderFirewall ? [modelProviderFirewall] : []),
      ...connectorFirewallConfigs,
    ],
  );

  return {
    secrets,
    environment,
    secretConnectorMap,
    resolvedModelProvider: modelProviderResult.resolvedModelProvider,
    modelProviderFirewall,
    selectedModel: modelProviderResult.selectedModel,
    connectorFirewalls: connectorFirewallConfigs,
    mergedVars,
  };
}

/**
 * Apply resolution defaults to context variables.
 * Params override resolution values (explicit CLI args win).
 */
function applyResolutionDefaults(
  params: BuildZeroContextParams,
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
 * Filter secretConnectorMap by removing keys that are overridden by
 * higher-priority secret sources (CLI, DB, model-provider).  Connector's own
 * injected env vars are NOT overrides — they come from the connector itself.
 *
 * @internal Exported for testing.
 */
export function filterSecretConnectorMap(
  secretConnectorMap: Record<string, string> | undefined,
  overrideSources: (Record<string, string> | undefined)[],
): Record<string, string> | undefined {
  if (!secretConnectorMap) return undefined;
  const overrideKeys = new Set(
    overrideSources.flatMap((s) => {
      return s ? Object.keys(s) : [];
    }),
  );
  const filtered = Object.fromEntries(
    Object.entries(secretConnectorMap).filter(([key]) => {
      return !overrideKeys.has(key);
    }),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/**
 * Merge model provider and connector firewalls into a single manifest.
 * Compose content no longer stores firewalls — all firewalls are runtime-injected.
 */
function mergeFirewalls(
  modelProviderFirewall: Firewalls[number] | null | undefined,
  connectorFirewalls: ExpandedFirewallConfig[],
  firewallPolicies?: FirewallPolicies,
  vars?: Record<string, string>,
): Firewalls | undefined {
  const autoFirewalls = modelProviderFirewall ? [modelProviderFirewall] : [];
  const policyFirewalls = applyConnectorPolicies(
    connectorFirewalls,
    firewallPolicies,
  );
  const allFirewalls = [...autoFirewalls, ...policyFirewalls];
  if (allFirewalls.length === 0) return undefined;
  return resolveFirewallBaseUrlVars(allFirewalls, vars);
}

/** Unrestricted permission — allows all endpoints through the proxy. */
export const UNRESTRICTED_PERMISSION = {
  name: "unrestricted",
  description: "Allow all endpoints",
  rules: ["ANY /{path*}"],
};

/**
 * Apply firewall policies to connector firewall configs.
 *
 * For each connector firewall:
 * - If the ref has explicit policies, only "allow" permissions are included.
 * - If the ref has no policies (or firewallPolicies is null), an "unrestricted"
 *   permission is added to allow all endpoints through the proxy.
 * - If all permissions are denied, the entry is excluded entirely.
 */
export function applyConnectorPolicies(
  connectorFirewalls: ExpandedFirewallConfig[],
  policies?: FirewallPolicies,
): Firewalls {
  const result: Firewalls = [];

  for (const fw of connectorFirewalls) {
    const refPolicies = policies?.[fw.ref];

    // If no policies or the firewall defines no permissions on any api,
    // treat all apis as unrestricted (no granular permission control).
    const hasPermissions = fw.apis.some((api) => {
      return api.permissions && api.permissions.length > 0;
    });

    const apis = fw.apis.map((api) => {
      if (!refPolicies || !hasPermissions) {
        return {
          base: api.base,
          auth: api.auth,
          permissions: [UNRESTRICTED_PERMISSION],
        };
      }

      const allowed = api.permissions?.filter((perm) => {
        return refPolicies[perm.name] === "allow";
      });

      return {
        base: api.base,
        auth: api.auth,
        permissions: allowed ?? [],
      };
    });

    result.push({ name: fw.name, ref: fw.ref, apis });
  }

  return result;
}

/**
 * Verify the caller's org has access to the session or checkpoint being resumed.
 * Must run BEFORE full source resolution to prevent leaking cross-org details
 * (e.g., framework mismatch errors).
 */
async function verifyOrgAccessForResume(params: {
  sessionId?: string;
  checkpointId?: string;
  userId: string;
  orgId: string;
}): Promise<void> {
  if (params.sessionId) {
    const session = await getAgentSessionWithConversation(params.sessionId);
    if (!session || session.userId !== params.userId) {
      throw notFound("Resource not found");
    }
    const [compose] = await globalThis.services.db
      .select({ orgId: agentComposes.orgId })
      .from(agentComposes)
      .where(eq(agentComposes.id, session.agentComposeId))
      .limit(1);
    if (!compose || compose.orgId !== params.orgId) {
      throw notFound("Resource not found");
    }
  } else if (params.checkpointId) {
    const [cp] = await globalThis.services.db
      .select({ orgId: agentRuns.orgId })
      .from(checkpoints)
      .innerJoin(agentRuns, eq(checkpoints.runId, agentRuns.id))
      .where(eq(checkpoints.id, params.checkpointId))
      .limit(1);
    if (!cp || cp.orgId !== params.orgId) {
      throw notFound("Resource not found");
    }
  }
}

/**
 * Resolve agentComposeVersionId from a composeId (head version lookup).
 * Verifies compose exists and belongs to the caller's org.
 */
async function resolveComposeFromId(
  composeId: string,
  orgId: string,
): Promise<string> {
  const [compose] = await globalThis.services.db
    .select({
      headVersionId: agentComposes.headVersionId,
      orgId: agentComposes.orgId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  if (!compose) {
    throw notFound("Agent compose not found");
  }
  if (compose.orgId !== orgId) {
    throw notFound("Resource not found");
  }
  if (!compose.headVersionId) {
    throw badRequest("Agent compose has no versions. Run 'vm0 build' first.");
  }
  return compose.headVersionId;
}

/**
 * Check that the resolved model provider is compatible with the original
 * provider from the session being continued.
 */
function checkProviderCompatibility(
  originalModelProvider: string | undefined,
  resolvedModelProvider: ModelProviderType | undefined,
): void {
  if (
    originalModelProvider &&
    resolvedModelProvider &&
    originalModelProvider in MODEL_PROVIDER_TYPES
  ) {
    const originalType = originalModelProvider as ModelProviderType;
    const newType = resolvedModelProvider as ModelProviderType;
    if (!areProvidersCompatible(originalType, newType)) {
      const originalLabel = MODEL_PROVIDER_TYPES[originalType].label;
      const newLabel = MODEL_PROVIDER_TYPES[newType].label;
      throw providerIncompatible(
        `Cannot continue session: this session was created with ${originalLabel} and cannot be continued with ${newLabel}. ` +
          `Please start a new session or switch back to a compatible model.`,
      );
    }
  }
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
  firewallPolicies?: FirewallPolicies;
  allowedConnectorTypes?: ConnectorType[];
  // Artifact/memory
  artifactName?: string;
  artifactVersion?: string;
  memoryName?: string;
  volumeVersions?: Record<string, string>;
}

/**
 * Pre-resolved context data for CLI runs.
 * Returned by resolveCliRunContext() for the CLI route to pass to startRun().
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
  resumeSession?: ResumeSession;
  resumeArtifact?: ArtifactSnapshot;

  // Secrets/environment resolution
  secrets?: Record<string, string>;
  environment?: Record<string, string>;
  secretConnectorMap?: Record<string, string>;
  firewalls?: Firewalls;
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
 * same resolution (vars, secrets, connectors, firewalls, timezone, model
 * provider) but returns pre-resolved data instead of a built ExecutionContext.
 * The CLI route calls this before startRun(), which then uses the pure
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
  let resumeSession: ResumeSession | undefined;
  let resumeArtifact: ArtifactSnapshot | undefined;

  // Step 1: Resolve source (checkpoint/session/conversation).
  const resolveStart = Date.now();
  const resolution = await resolveSource({
    ...params,
    // Required fields for resolveSource that don't apply to CLI resolution
    prompt: "",
    sandboxToken: "",
    runId: "",
  });
  const resolveEnd = Date.now();

  // Step 2: Apply resolution defaults
  if (resolution) {
    const defaults = applyResolutionDefaults(
      {
        ...params,
        prompt: "",
        sandboxToken: "",
        runId: "",
      },
      resolution,
    );
    agentComposeVersionId = defaults.agentComposeVersionId;
    agentCompose = defaults.agentCompose;
    artifactName = defaults.artifactName;
    artifactVersion = defaults.artifactVersion;
    memoryName = defaults.memoryName;
    vars = defaults.vars;
    volumeVersions = defaults.volumeVersions;
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
    modelProviderFirewall,
    selectedModel,
    connectorFirewalls,
    mergedVars,
  } = secretsResult;
  const userTimezone = userPrefs?.timezone ?? undefined;

  // Step 5: Provider compatibility check for session continues.
  checkProviderCompatibility(originalModelProvider, resolvedModelProvider);

  // Build firewall manifest
  const firewalls = mergeFirewalls(
    modelProviderFirewall,
    connectorFirewalls,
    params.firewallPolicies,
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
    resumeSession,
    resumeArtifact,
    secrets,
    environment,
    secretConnectorMap,
    firewalls,
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
 * (model providers, secrets, connectors, variables, user preferences, firewalls)
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
    ),
    params.userId
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
    modelProviderFirewall,
    selectedModel,
    connectorFirewalls,
    mergedVars,
  } = secretsResult;
  const userTimezone = userPrefs?.timezone ?? undefined;

  // Step 5: Provider compatibility check for session continues.
  // When resuming a session, verify the new provider is compatible with the
  // original provider to avoid mid-conversation base URL mismatches.
  if (
    originalModelProvider &&
    resolvedModelProvider &&
    originalModelProvider in MODEL_PROVIDER_TYPES
  ) {
    const originalType = originalModelProvider as ModelProviderType;
    const newType = resolvedModelProvider as ModelProviderType;
    if (!areProvidersCompatible(originalType, newType)) {
      const originalLabel = MODEL_PROVIDER_TYPES[originalType].label;
      const newLabel = MODEL_PROVIDER_TYPES[newType].label;
      throw providerIncompatible(
        `Cannot continue session: this session was created with ${originalLabel} and cannot be continued with ${newLabel}. ` +
          `Please start a new session or switch back to a compatible model.`,
      );
    }
  }

  // Build firewall manifest (base + auth entries for the runner).
  const firewalls = mergeFirewalls(
    modelProviderFirewall,
    connectorFirewalls,
    params.firewallPolicies,
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
      environment,
      userTimezone,
      firewalls,
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
