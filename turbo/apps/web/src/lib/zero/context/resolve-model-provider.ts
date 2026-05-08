import {
  getFrameworkForType,
  getSecretNameForType,
  getEnvironmentMapping,
  getDefaultModel,
  hasAuthMethods,
  getSecretsForAuthMethod,
  MODEL_PROVIDER_TYPES,
  getVm0ConcreteProviderType,
  getVm0Vendor,
  getVm0ApiModel,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  badRequest,
  noModelProvider,
  staleProvider,
} from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";
import { getSecretValue, getSecretValues } from "../secret/secret-service";
import {
  getOrgDefaultModelProvider,
  getOrgAnyDefaultModelProvider,
  getModelProviderById,
  getOrgModelProviderByType,
  getUserDefaultModelProvider,
  getUserAnyDefaultModelProvider,
  getUserModelProviderByType,
} from "../model-provider/model-provider-service";
import { getVm0ApiKey } from "../vm0-key/vm0-key-service";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { MODEL_PROVIDER_HANDLER_KEY } from "../handler-key-bridge";
import { PROVIDER_HANDLERS } from "../connector/provider-registry";
import { isPersonalTierEligible } from "../personal-tier-gate";
import type { SecretConnectorMetadata } from "@vm0/api-contracts/contracts/runners";

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
   *  Undefined when provider resolution was skipped (explicit env vars). */
  resolvedModelProvider: ModelProviderType | undefined;
  /** Canonical framework for this resolution. When a provider was resolved this
   *  is the provider's framework (source-of-truth for downstream); otherwise
   *  the input `framework` is echoed back. */
  framework: string;
  /** For meta-providers like "vm0", the concrete provider type resolved at build time.
   *  Used for firewall lookup instead of the meta-provider type. */
  concreteProviderType?: ModelProviderType;
  /** The logical model name selected by the user (e.g. "claude-sonnet-4-6").
   *  Used for model usage billing. */
  selectedModel?: string;
  /** Maps secret/env-var names → connector handler key for refresh-capable
   *  model-provider OAuth secrets (e.g. CHATGPT_ACCESS_TOKEN → "codex-oauth").
   *  Merged into the wire `secretConnectorMap` AFTER `filterSecretConnectorMap`
   *  runs — the filter would otherwise drop these because they also appear in
   *  `secrets`, but model-provider entries ARE the source, not an override target. */
  secretConnectorMap?: Record<string, string>;
  /** Per-secret owner metadata for refresh-capable model-provider OAuth secrets.
   *  The firewall refresh path uses this to refresh personal providers under
   *  the provider row owner instead of the org sentinel. */
  secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
}

/**
 * Build the secretConnectorMap entries for a model-provider type whose
 * tokens are OAuth-refreshable (e.g. codex-oauth-token).
 *
 * Returns undefined when the provider has no bridged handler or its handler
 * lacks `refreshToken` — for non-OAuth providers the firewall has nothing
 * to refresh and should not see the secret in the map.
 *
 * The returned map is merged INTO the wire `secretConnectorMap` after
 * `filterSecretConnectorMap` runs; see `build-zero-context.ts`.
 */
function buildModelProviderRefreshMaps(
  providerType: ModelProviderType,
  sourceUserId: string,
):
  | {
      secretConnectorMap: Record<string, string>;
      secretConnectorMetadataMap: Record<string, SecretConnectorMetadata>;
    }
  | undefined {
  const handlerKey = MODEL_PROVIDER_HANDLER_KEY[providerType];
  if (!handlerKey) return undefined;

  const handler =
    PROVIDER_HANDLERS[handlerKey as keyof typeof PROVIDER_HANDLERS];
  if (!handler?.refreshToken) return undefined;

  const accessSecretName = handler.getSecretName();
  const result: Record<string, string> = { [accessSecretName]: handlerKey };

  // Mirror the connector-side aliasing logic: any environmentMapping entry
  // that references the access-token secret should also appear in the map
  // so the firewall can refresh tokens regardless of which name a template
  // references.
  const envMapping = getEnvironmentMapping(providerType);
  if (envMapping) {
    for (const [envVar, valueRef] of Object.entries(envMapping)) {
      if (valueRef === `$secrets.${accessSecretName}`) {
        result[envVar] = handlerKey;
      }
    }
  }
  return {
    secretConnectorMap: result,
    secretConnectorMetadataMap: Object.fromEntries(
      Object.keys(result).map((key) => {
        return [
          key,
          {
            sourceType: "model-provider" as const,
            sourceUserId,
            metadataKey: providerType,
          },
        ];
      }),
    ),
  };
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
    framework: getFrameworkForType("vm0"),
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

  const secretsConfig = getSecretsForAuthMethod(providerType, authMethod);
  if (!secretsConfig || Object.keys(secretsConfig).length === 0) {
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

  for (const [name, config] of Object.entries(secretsConfig)) {
    const value = allSecretValues[name];
    if (value) {
      secretsMap[name] = value;
    } else if (config.required) {
      log.debug(`Missing secret ${name} for ${providerType}/${authMethod}`);
      hasAllRequired = false;
    }
  }

  if (!hasAllRequired) {
    return undefined;
  }

  // Filter out serverOnly secrets (e.g., OAuth refresh tokens, ID tokens)
  // before forwarding to the runner — these stay server-side per #7365.
  // The full secrets map is still consumed by the OAuth/persistence path
  // (write side); only this build-context (read side) drops them.
  const secretConfigs = getSecretsForAuthMethod(providerType, authMethod);
  const forwardableSecrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(secretsMap)) {
    if (!secretConfigs?.[name]?.serverOnly) {
      forwardableSecrets[name] = value;
    }
  }

  const injectedEnvironment = resolveEnvironmentMapping(
    providerType,
    undefined,
    selectedModel,
    new Set(Object.keys(forwardableSecrets)),
  );
  const refreshMaps = buildModelProviderRefreshMaps(providerType, secretUserId);

  log.debug(
    `Resolved multi-auth model provider env: ${Object.keys(injectedEnvironment).join(", ")}`,
  );

  return {
    secrets: forwardableSecrets,
    injectedEnvironment,
    resolvedModelProvider: providerType,
    framework: getFrameworkForType(providerType),
    selectedModel,
    secretConnectorMap: refreshMaps?.secretConnectorMap,
    secretConnectorMetadataMap: refreshMaps?.secretConnectorMetadataMap,
  };
}

/**
 * Resolve the row used as the resolution anchor: explicit ID pin → personal
 * tier (when eligible) → org chain. Returns null only when neither tier has
 * a default; the caller then funnels into the explicit-type-override path
 * or `noModelProvider()`.
 */
async function resolveDefaultProviderRow(params: {
  orgId: string;
  userId: string;
  framework: string;
  modelProviderId: string | undefined;
  personalEligible: boolean;
}): Promise<Awaited<ReturnType<typeof getOrgDefaultModelProvider>>> {
  const { orgId, userId, framework, modelProviderId, personalEligible } =
    params;
  if (modelProviderId) {
    return getModelProviderById(orgId, userId, modelProviderId);
  }
  if (personalEligible) {
    const userRow =
      (await getUserDefaultModelProvider(orgId, userId, framework)) ??
      (await getUserAnyDefaultModelProvider(orgId, userId));
    if (userRow) return userRow;
  }
  return (
    (await getOrgDefaultModelProvider(orgId, framework)) ??
    (await getOrgAnyDefaultModelProvider(orgId))
  );
}

/**
 * Resolve the row whose `selectedModel` / `authMethod` should drive secret
 * resolution for `providerType`. When `defaultProvider` already matches the
 * type, reuse it. Otherwise — only on the explicit type-override path
 * (where `explicitModelProvider` was set and no `modelProviderId` pin) —
 * look up by type, consulting personal tier first when eligible. Returns
 * null when no row exists; callers then fall back to `getDefaultModel`.
 */
async function resolveMatchingProviderForType(params: {
  orgId: string;
  userId: string;
  providerType: ModelProviderType;
  defaultProvider: Awaited<ReturnType<typeof getOrgDefaultModelProvider>>;
  explicitModelProvider: string | undefined;
  modelProviderId: string | undefined;
  personalEligible: boolean;
}): Promise<Awaited<ReturnType<typeof getOrgDefaultModelProvider>>> {
  const {
    orgId,
    userId,
    providerType,
    defaultProvider,
    explicitModelProvider,
    modelProviderId,
    personalEligible,
  } = params;
  if (defaultProvider && defaultProvider.type === providerType) {
    return defaultProvider;
  }
  if (!explicitModelProvider || modelProviderId) return null;
  if (personalEligible) {
    const userRow = await getUserModelProviderByType(
      orgId,
      userId,
      providerType,
    );
    if (userRow) return userRow;
  }
  return getOrgModelProviderByType(orgId, providerType);
}

/**
 * Resolve and inject model provider secret if needed
 * Only injects if no explicit model provider config in compose environment
 *
 * For providers with environment mapping (e.g., moonshot), resolves all env vars
 *
 * @param modelProviderId - Optional specific provider ID to use instead of org default
 * @param selectedModelOverride - Optional model override (takes precedence over provider's selectedModel)
 * @param preferPersonalProvider - When true AND `personalModelProvider` switch
 *   is on for the caller, the resolver consults the user's personal-tier
 *   providers before the org default. Off-by-default; matches today's
 *   behavior when omitted/false. Sourced from `zero_agents.preferPersonalProvider`
 *   (or schedule's column when running a schedule).
 */
export async function resolveModelProviderSecrets(
  orgId: string,
  userId: string,
  framework: string,
  hasExplicitModelProviderConfig: boolean,
  explicitModelProvider?: string,
  modelProviderId?: string,
  selectedModelOverride?: string,
  preferPersonalProvider?: boolean,
): Promise<ModelProviderSecretResult> {
  const secrets: Record<string, string> | undefined = undefined;

  // Skip if compose already declares the framework's auth env var directly.
  // Framework-agnostic: codex with explicit OPENAI_API_KEY short-circuits here
  // just like claude-code with explicit ANTHROPIC_API_KEY.
  if (hasExplicitModelProviderConfig) {
    return {
      secrets,
      injectedEnvironment: undefined,
      resolvedModelProvider: undefined,
      framework,
    };
  }

  // Resolve provider: specific ID override → personal-tier branch (gated) →
  // framework-scoped org default → cross-framework fallback. The personal
  // branch is consulted first only when (Epic #11868):
  //   1. caller opted in via agent/schedule `prefer_personal_provider` AND
  //   2. the `personalModelProvider` feature switch is on for the caller.
  // The cross-framework fallback (org chain, identical user chain) mirrors
  // admission (zero-run-policy.ts) and implements Epic #11520's "provider's
  // framework wins" rule at the dispatch boundary: an org with only a codex
  // provider still resolves secrets for a claude-code compose; the
  // provider's framework propagates downstream via `resolvedFramework`.
  const personalEligible = await isPersonalTierEligible(
    orgId,
    userId,
    preferPersonalProvider,
  );
  const defaultProvider = await resolveDefaultProviderRow({
    orgId,
    userId,
    framework,
    modelProviderId,
    personalEligible,
  });

  const providerType = resolveProviderType(
    defaultProvider,
    explicitModelProvider,
  );
  // Only borrow `selectedModel` / `authMethod` from a provider row that
  // actually matches the resolved `providerType`. When an explicit
  // `modelProvider` request differs from the workspace default's type (e.g.
  // workspace default is `claude-code-oauth-token` with selectedModel
  // `claude-sonnet-4-5`, request asks for `openai-api-key`), passing the
  // foreign selectedModel through would inject `OPENAI_MODEL=claude-sonnet-4-5`
  // and the codex CLI would refuse to run.
  //
  // When defaultProvider is for the wrong type AND we have an explicit type
  // override (no modelProviderId pin), look up the explicit provider's row
  // by type so vm0/multi-auth flows still see their stored selectedModel/
  // authMethod. The user-tier lookup is consulted first when
  // `personalEligible` so a user with a personal `openai-api-key` row gets
  // their own secret + selectedModel even when their default is org-tier
  // (Epic #11868). Falls back to undefined when no row exists, in which case
  // `resolveEnvironmentMapping` uses `getDefaultModel(providerType)`.
  const matchingProvider = await resolveMatchingProviderForType({
    orgId,
    userId,
    providerType,
    defaultProvider,
    explicitModelProvider,
    modelProviderId,
    personalEligible,
  });
  // Derive `secretUserId` from the row whose secret we're about to fetch
  // (`matchingProvider`), not blindly from `defaultProvider`. They diverge
  // in the explicit-type-override path: an explicit `openai-api-key`
  // request can land on the org's `openai-api-key` even when the user has
  // a personal default of a different type. The secret lives under the
  // matching row's owner — using `defaultProvider.userId` would miss the
  // org's OPENAI_API_KEY in that case (Epic #11868 — replaces the prior
  // hardcoded sentinel).
  const secretUserId = matchingProvider?.userId ?? ORG_SENTINEL_USER_ID;
  // selectedModelOverride (from agent/schedule config) takes precedence over provider's stored model
  const selectedModel =
    selectedModelOverride ?? matchingProvider?.selectedModel ?? undefined;

  // Stale-provider gate: an OAuth-typed provider whose refresh failed
  // (needsReconnect flipped by the firewall webhook in #11921) MUST NOT
  // dispatch a sandbox — the user would see a confusing 401 mid-run.
  // Failing fast here covers chat dispatch + CLI runs + scheduled runs from
  // the single resolver choke point.
  if (matchingProvider?.needsReconnect) {
    throw staleProvider(
      matchingProvider.type,
      matchingProvider.lastRefreshErrorCode,
    );
  }

  // Handle VM0 managed provider (meta-provider resolution)
  if (providerType === "vm0") {
    if (!selectedModel) {
      throw badRequest("VM0 provider requires a selected model");
    }
    return resolveVm0Provider(selectedModel);
  }

  const resolvedFramework = getFrameworkForType(providerType);

  // Handle multi-auth providers (like aws-bedrock)
  if (hasAuthMethods(providerType)) {
    const resolved = await resolveMultiAuthProviderSecrets(
      orgId,
      secretUserId,
      providerType,
      matchingProvider?.authMethod,
      selectedModel,
    );
    return (
      resolved ?? {
        secrets,
        injectedEnvironment: undefined,
        resolvedModelProvider: providerType,
        framework: resolvedFramework,
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
      framework: resolvedFramework,
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
      framework: resolvedFramework,
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
    framework: resolvedFramework,
    selectedModel,
  };
}
