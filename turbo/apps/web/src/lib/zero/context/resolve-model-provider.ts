import {
  getFrameworkForType,
  getSecretNameForType,
  getEnvironmentMapping,
  getDefaultModel,
  hasAuthMethods,
  getSecretNamesForAuthMethod,
  MODEL_PROVIDER_TYPES,
  getVm0ConcreteProviderType,
  getVm0Vendor,
  getVm0ApiModel,
  type ModelProviderType,
  type ModelProviderFramework,
} from "@vm0/core";
import { badRequest, noModelProvider } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { getSecretValue, getSecretValues } from "../secret/secret-service";
import {
  getOrgDefaultModelProvider,
  getModelProviderByIdForOrg,
} from "../model-provider/model-provider-service";
import { getVm0ApiKey } from "../vm0-key/vm0-key-service";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";

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
  /** The logical model name selected by the user (e.g. "claude-sonnet-4-6").
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
  const apiModel = getVm0ApiModel(selectedModel);
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
    apiModel,
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
 * Resolve secrets for a multi-auth provider (e.g., aws-bedrock).
 * Returns undefined if the auth method or required secrets are missing.
 */
async function resolveMultiAuthProviderSecrets(
  orgId: string,
  secretUserId: string,
  providerType: ModelProviderType,
  authMethod: string | undefined | null,
  selectedModel: string | undefined,
): Promise<ModelProviderSecretResult | undefined> {
  if (!authMethod) {
    log.debug(
      `Multi-auth provider ${providerType} has no auth method configured`,
    );
    return undefined;
  }

  const secretNames = getSecretNamesForAuthMethod(providerType, authMethod);
  if (!secretNames || secretNames.length === 0) {
    log.debug(`No secret names found for ${providerType}/${authMethod}`);
    return undefined;
  }

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
    return undefined;
  }

  const injectedEnvironment = resolveEnvironmentMapping(
    providerType,
    undefined,
    selectedModel,
    new Set(secretNames),
  );

  log.debug(
    `Resolved multi-auth model provider env: ${Object.keys(injectedEnvironment).join(", ")}`,
  );

  return {
    secrets: secretsMap,
    injectedEnvironment,
    resolvedModelProvider: providerType,
    selectedModel,
  };
}

/**
 * Resolve and inject model provider secret if needed
 * Only injects if no explicit model provider config in compose environment
 *
 * For providers with environment mapping (e.g., moonshot), resolves all env vars
 *
 * @param modelProviderId - Optional specific provider ID to use instead of org default
 * @param selectedModelOverride - Optional model override (takes precedence over provider's selectedModel)
 */
export async function resolveModelProviderSecrets(
  orgId: string,
  framework: string,
  hasExplicitModelProviderConfig: boolean,
  explicitModelProvider?: string,
  modelProviderId?: string,
  selectedModelOverride?: string,
): Promise<ModelProviderSecretResult> {
  const secrets: Record<string, string> | undefined = undefined;

  // Skip if explicit model provider config exists or framework doesn't use model providers
  if (hasExplicitModelProviderConfig || framework !== "claude-code") {
    return {
      secrets,
      injectedEnvironment: undefined,
      resolvedModelProvider: undefined,
    };
  }

  // Resolve provider: specific ID override → org default
  let defaultProvider: Awaited<ReturnType<typeof getOrgDefaultModelProvider>>;
  if (modelProviderId) {
    defaultProvider = await getModelProviderByIdForOrg(orgId, modelProviderId);
  } else {
    defaultProvider = await getOrgDefaultModelProvider(
      orgId,
      framework as ModelProviderFramework,
    );
  }

  const secretUserId = ORG_SENTINEL_USER_ID;

  const providerType = resolveProviderType(
    framework,
    defaultProvider,
    explicitModelProvider,
  );
  // selectedModelOverride (from agent/schedule config) takes precedence over provider's stored model
  const selectedModel =
    selectedModelOverride ?? defaultProvider?.selectedModel ?? undefined;

  // Handle VM0 managed provider (meta-provider resolution)
  if (providerType === "vm0") {
    if (!selectedModel) {
      throw badRequest("VM0 provider requires a selected model");
    }
    return resolveVm0Provider(selectedModel);
  }

  // Handle multi-auth providers (like aws-bedrock)
  if (hasAuthMethods(providerType)) {
    const resolved = await resolveMultiAuthProviderSecrets(
      orgId,
      secretUserId,
      providerType,
      defaultProvider?.authMethod,
      selectedModel,
    );
    return (
      resolved ?? {
        secrets,
        injectedEnvironment: undefined,
        resolvedModelProvider: providerType,
        selectedModel,
      }
    );
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
    secrets: { [secretName]: secretValue },
    injectedEnvironment,
    resolvedModelProvider: providerType,
    selectedModel,
  };
}
