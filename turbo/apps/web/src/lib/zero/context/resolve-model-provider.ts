import {
  getFrameworkForType,
  getSecretNameForType,
  getEnvironmentMapping,
  getDefaultModel,
  hasAuthMethods,
  getSecretsForAuthMethod,
  MODEL_PROVIDER_TYPES,
  getProviderRuntimeModel,
  getVm0ConcreteProviderType,
  getVm0Vendor,
  type ModelProviderCredentialScope,
  type ModelProviderFramework,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  badRequest,
  modelProviderConnectRequired,
  noModelProvider,
  providerDeleted,
  staleProvider,
} from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";
import { getSecretValue, getSecretValues } from "../secret/secret-service";
import {
  getOrgDefaultModelProvider,
  getOrgAnyDefaultModelProvider,
  getModelProviderById,
  getOrgModelProviderByType,
  getUserModelProviderByType,
} from "../model-provider/model-provider-service";
import { getVm0ApiKey } from "../vm0-key/vm0-key-service";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { MODEL_PROVIDER_HANDLER_KEY } from "../handler-key-bridge";
import { PROVIDER_HANDLERS } from "../connector/provider-registry";
import {
  isModelFirstModelProviderEnabled,
  resolveModelFirstRouteDescriptor,
} from "../model-policy/model-first-route-service";
import { getAppUrl } from "../url";
import type { SecretConnectorMetadata } from "@vm0/api-contracts/contracts/runners";
import type { ModelProviderInfo } from "../model-provider/model-provider-service";

const log = logger("zero:build-context");

function getModelProviderConnectRequiredUrl(providerType: string): string {
  const searchParams = new URLSearchParams({
    tab: "model-configuration",
    connectModelProvider: providerType,
  });
  return `${getAppUrl()}/settings?${searchParams.toString()}`;
}

function getModelProviderConnectRequiredMessage(providerType: string): string {
  const url = getModelProviderConnectRequiredUrl(providerType);
  return [
    `Connect "${providerType}" before using this workspace model route.`,
    `[Open Personal Models](${url})`,
  ].join(" ");
}

function throwModelProviderConnectRequired(providerType: string): never {
  throw modelProviderConnectRequired(
    providerType,
    getModelProviderConnectRequiredMessage(providerType),
  );
}

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

export interface ResolveModelProviderSecretTimings {
  defaultProviderLookup: number;
  matchingProviderLookup: number;
  vm0ProviderResolution?: number;
  multiAuthSecretResolution?: number;
  singleSecretFetch?: number;
  environmentMapping?: number;
}

interface ResolvedModelRouteModel {
  /** Model explicitly chosen by the caller, provider row, or model-first policy. */
  selected: string | undefined;
  /** Effective canonical model after default fallback, when the provider has one. */
  canonical: string | undefined;
  /** Provider-specific runtime model id after alias translation. */
  runtime: string | undefined;
}

interface ResolvedModelRouteProvider {
  type: ModelProviderType;
  /** Concrete upstream provider for meta-providers like vm0. */
  concreteType?: ModelProviderType;
}

type ResolvedModelRouteCredential =
  | {
      scope: "org";
      modelProviderId: string | null;
      ownerUserId: typeof ORG_SENTINEL_USER_ID;
    }
  | {
      scope: "member";
      modelProviderId: string | null;
      ownerUserId: string;
    };

interface ResolvedModelRouteSourceProvider {
  id: string;
  userId: string;
  type: ModelProviderType;
  authMethod?: string | null;
  selectedModel: string | null;
  needsReconnect: boolean;
  lastRefreshErrorCode: string | null;
}

interface ResolvedModelRoute {
  source: "legacy" | "model-first";
  framework: ModelProviderFramework;
  model: ResolvedModelRouteModel;
  provider: ResolvedModelRouteProvider;
  credential: ResolvedModelRouteCredential;
  sourceProvider?: ResolvedModelRouteSourceProvider;
}

interface ResolveModelRouteParams {
  orgId: string;
  userId: string;
  framework: string;
  explicitModelProvider?: string;
  modelProviderId?: string;
  selectedModelOverride?: string;
  modelProviderCredentialScope?: string;
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
  /** Model-first route ownership for audit/pinning. Undefined on legacy paths. */
  credentialScope?: ModelProviderCredentialScope;
  /** Org-scoped model provider row used by model-first API-key routes. */
  modelProviderId?: string | null;
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
  timings?: ResolveModelProviderSecretTimings;
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

function toRouteSourceProvider(
  provider: ModelProviderInfo | null | undefined,
): ResolvedModelRouteSourceProvider | undefined {
  if (!provider) return undefined;
  return {
    id: provider.id,
    userId: provider.userId,
    type: provider.type,
    authMethod: provider.authMethod,
    selectedModel: provider.selectedModel,
    needsReconnect: provider.needsReconnect,
    lastRefreshErrorCode: provider.lastRefreshErrorCode,
  };
}

function assertProviderFresh(provider: ModelProviderInfo | null): void {
  if (!provider?.needsReconnect) return;
  throw staleProvider(provider.type, provider.lastRefreshErrorCode);
}

function getVm0ConcreteProviderTypeForRoute(
  selectedModel: string,
): ModelProviderType {
  try {
    return getVm0ConcreteProviderType(selectedModel);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Unknown VM0 model "${selectedModel}"`;
    throw badRequest(message);
  }
}

function resolveRouteModel(
  providerType: ModelProviderType,
  selectedModel: string | undefined,
): ResolvedModelRouteModel {
  const defaultModel = getDefaultModel(providerType) || undefined;
  const canonical = selectedModel ?? defaultModel;
  return {
    selected: selectedModel,
    canonical,
    runtime: canonical
      ? getProviderRuntimeModel(providerType, canonical)
      : undefined,
  };
}

function resolveRouteProvider(
  providerType: ModelProviderType,
  canonicalModel: string | undefined,
): ResolvedModelRouteProvider {
  if (providerType !== "vm0") {
    return { type: providerType };
  }
  if (!canonicalModel) {
    throw badRequest("VM0 provider requires a selected model");
  }
  return {
    type: providerType,
    concreteType: getVm0ConcreteProviderTypeForRoute(canonicalModel),
  };
}

function buildRouteCredential(params: {
  scope: ModelProviderCredentialScope;
  modelProviderId: string | null;
  ownerUserId: string;
}): ResolvedModelRouteCredential {
  if (params.scope === "org") {
    return {
      scope: "org",
      modelProviderId: params.modelProviderId,
      ownerUserId: ORG_SENTINEL_USER_ID,
    };
  }
  return {
    scope: "member",
    modelProviderId: params.modelProviderId,
    ownerUserId: params.ownerUserId,
  };
}

function buildResolvedModelRoute(params: {
  source: ResolvedModelRoute["source"];
  providerType: ModelProviderType;
  selectedModel: string | undefined;
  credentialScope: ModelProviderCredentialScope;
  modelProviderId: string | null;
  ownerUserId: string;
  sourceProvider?: ModelProviderInfo | null;
}): ResolvedModelRoute {
  const model = resolveRouteModel(params.providerType, params.selectedModel);
  const provider = resolveRouteProvider(params.providerType, model.canonical);
  return {
    source: params.source,
    framework: getFrameworkForType(provider.concreteType ?? provider.type),
    model,
    provider,
    credential: buildRouteCredential({
      scope: params.credentialScope,
      modelProviderId: params.modelProviderId,
      ownerUserId: params.ownerUserId,
    }),
    sourceProvider: toRouteSourceProvider(params.sourceProvider),
  };
}

function shouldExposeRouteCredentialMetadata(
  route: ResolvedModelRoute,
): boolean {
  return route.source === "model-first" || route.provider.type === "vm0";
}

function withRouteMetadata(
  route: ResolvedModelRoute,
  result: ModelProviderSecretResult,
): ModelProviderSecretResult {
  const includeCredentialMetadata = shouldExposeRouteCredentialMetadata(route);
  const selectedModel =
    route.provider.type === "vm0"
      ? route.model.canonical
      : route.model.selected;
  return {
    ...result,
    resolvedModelProvider: route.provider.type,
    framework: route.framework,
    concreteProviderType: route.provider.concreteType,
    selectedModel,
    credentialScope: includeCredentialMetadata
      ? route.credential.scope
      : undefined,
    modelProviderId: includeCredentialMetadata
      ? route.credential.modelProviderId
      : undefined,
  };
}

function finalizeMaterializedRoute(
  route: ResolvedModelRoute,
  result: ModelProviderSecretResult,
): ModelProviderSecretResult {
  const decorated = withRouteMetadata(route, result);
  if (
    route.source === "model-first" &&
    route.credential.scope === "member" &&
    !decorated.secrets
  ) {
    throwModelProviderConnectRequired(route.provider.type);
  }
  return decorated;
}

/**
 * Resolve VM0 managed provider: map selected model to concrete provider,
 * fetch API key from pool, and resolve environment mapping.
 */
async function resolveVm0Provider(
  selectedModel: string,
): Promise<ModelProviderSecretResult> {
  const concreteType = getVm0ConcreteProviderTypeForRoute(selectedModel);
  const vendor = getVm0Vendor(selectedModel);
  const apiModel = getProviderRuntimeModel("vm0", selectedModel);
  const poolKey = await getVm0ApiKey(vendor, apiModel);
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
    framework: getFrameworkForType(concreteType),
    concreteProviderType: concreteType,
    selectedModel,
    credentialScope: "org",
    modelProviderId: null,
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
  metadataSelectedModel: string | undefined = selectedModel,
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
    selectedModel: metadataSelectedModel,
    secretConnectorMap: refreshMaps?.secretConnectorMap,
    secretConnectorMetadataMap: refreshMaps?.secretConnectorMetadataMap,
  };
}

async function materializeModelRoute(params: {
  orgId: string;
  route: ResolvedModelRoute;
  timings?: ResolveModelProviderSecretTimings;
}): Promise<ModelProviderSecretResult> {
  const { orgId, route, timings } = params;
  const providerType = route.provider.type;
  const secretUserId = route.credential.ownerUserId;

  if (providerType === "vm0") {
    if (!route.model.canonical) {
      throw badRequest("VM0 provider requires a selected model");
    }
    const vm0ProviderStart = Date.now();
    const resolved = await resolveVm0Provider(route.model.canonical);
    if (timings) {
      timings.vm0ProviderResolution = Date.now() - vm0ProviderStart;
    }
    return finalizeMaterializedRoute(route, resolved);
  }

  if (hasAuthMethods(providerType)) {
    const multiAuthStart = Date.now();
    const resolved = await resolveMultiAuthProviderSecrets(
      orgId,
      secretUserId,
      providerType,
      route.sourceProvider?.authMethod,
      route.model.runtime,
      route.model.selected,
    );
    if (timings) {
      timings.multiAuthSecretResolution = Date.now() - multiAuthStart;
    }
    const result =
      resolved ??
      ({
        secrets: undefined,
        injectedEnvironment: undefined,
        resolvedModelProvider: providerType,
        framework: route.framework,
        selectedModel: route.model.selected,
      } satisfies ModelProviderSecretResult);
    return finalizeMaterializedRoute(route, result);
  }

  const secretName = getSecretNameForType(providerType);
  if (!secretName) {
    return finalizeMaterializedRoute(route, {
      secrets: undefined,
      injectedEnvironment: undefined,
      resolvedModelProvider: providerType,
      framework: route.framework,
      selectedModel: route.model.selected,
    });
  }

  const secretFetchStart = Date.now();
  const secretValue = await getSecretValue(
    orgId,
    secretUserId,
    secretName,
    "model-provider",
  );
  if (timings) {
    timings.singleSecretFetch = Date.now() - secretFetchStart;
  }

  if (!secretValue) {
    return finalizeMaterializedRoute(route, {
      secrets: undefined,
      injectedEnvironment: undefined,
      resolvedModelProvider: providerType,
      framework: route.framework,
      selectedModel: route.model.selected,
    });
  }

  const environmentMappingStart = Date.now();
  const injectedEnvironment = resolveEnvironmentMapping(
    providerType,
    secretName,
    route.model.runtime,
  );
  if (timings) {
    timings.environmentMapping = Date.now() - environmentMappingStart;
  }

  log.debug(
    `Resolved model provider env: ${Object.keys(injectedEnvironment).join(", ")}`,
  );

  return finalizeMaterializedRoute(route, {
    secrets: { [secretName]: secretValue },
    injectedEnvironment,
    resolvedModelProvider: providerType,
    framework: route.framework,
    selectedModel: route.model.selected,
  });
}

/**
 * Resolve the row used as the resolution anchor: explicit ID pin → org chain.
 * Returns null only when no org default exists; the caller then funnels into
 * the explicit-type-override path or `noModelProvider()`.
 */
async function resolveDefaultProviderRow(params: {
  orgId: string;
  userId: string;
  framework: string;
  modelProviderId: string | undefined;
}): Promise<Awaited<ReturnType<typeof getOrgDefaultModelProvider>>> {
  const { orgId, userId, framework, modelProviderId } = params;
  if (modelProviderId) {
    return getModelProviderById(orgId, userId, modelProviderId);
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
 * look up the org row by type. Returns null when no row exists; callers then
 * fall back to `getDefaultModel`.
 */
async function resolveMatchingProviderForType(params: {
  orgId: string;
  providerType: ModelProviderType;
  defaultProvider: Awaited<ReturnType<typeof getOrgDefaultModelProvider>>;
  explicitModelProvider: string | undefined;
  modelProviderId: string | undefined;
}): Promise<Awaited<ReturnType<typeof getOrgDefaultModelProvider>>> {
  const {
    orgId,
    providerType,
    defaultProvider,
    explicitModelProvider,
    modelProviderId,
  } = params;
  if (defaultProvider && defaultProvider.type === providerType) {
    return defaultProvider;
  }
  if (!explicitModelProvider || modelProviderId) return null;
  return getOrgModelProviderByType(orgId, providerType);
}

async function resolveModelFirstModelRoute(
  params: ResolveModelRouteParams,
): Promise<ResolvedModelRoute> {
  const descriptor = await resolveModelFirstRouteDescriptor({
    orgId: params.orgId,
    userId: params.userId,
    selectedModel: params.selectedModelOverride,
    providerType: params.explicitModelProvider,
    credentialScope: params.modelProviderCredentialScope,
    modelProviderId: params.modelProviderId,
  });

  let providerRow: ModelProviderInfo | null = null;
  let ownerUserId = ORG_SENTINEL_USER_ID;

  if (descriptor.credentialScope === "member") {
    providerRow = await getUserModelProviderByType(
      params.orgId,
      params.userId,
      descriptor.providerType,
    );
    if (!providerRow) {
      throwModelProviderConnectRequired(descriptor.providerType);
    }
    ownerUserId = params.userId;
  } else if (descriptor.providerType !== "vm0") {
    if (!descriptor.modelProviderId) {
      throw badRequest("Org-scoped model route is missing modelProviderId");
    }
    providerRow = await getModelProviderById(
      params.orgId,
      params.userId,
      descriptor.modelProviderId,
    );
    if (
      !providerRow ||
      providerRow.userId !== ORG_SENTINEL_USER_ID ||
      providerRow.type !== descriptor.providerType
    ) {
      throw providerDeleted();
    }
  }

  assertProviderFresh(providerRow);

  return buildResolvedModelRoute({
    source: "model-first",
    providerType: descriptor.providerType,
    selectedModel: descriptor.selectedModel,
    credentialScope: descriptor.credentialScope,
    modelProviderId: descriptor.modelProviderId,
    ownerUserId,
    sourceProvider: providerRow,
  });
}

async function resolveLegacyModelRoute(
  params: ResolveModelRouteParams,
  timings?: ResolveModelProviderSecretTimings,
): Promise<ResolvedModelRoute> {
  const defaultProviderStart = Date.now();
  const defaultProvider = await resolveDefaultProviderRow({
    orgId: params.orgId,
    userId: params.userId,
    framework: params.framework,
    modelProviderId: params.modelProviderId,
  });
  if (timings) {
    timings.defaultProviderLookup = Date.now() - defaultProviderStart;
  }

  const providerType = resolveProviderType(
    defaultProvider,
    params.explicitModelProvider,
  );

  const matchingProviderStart = Date.now();
  const matchingProvider = await resolveMatchingProviderForType({
    orgId: params.orgId,
    providerType,
    defaultProvider,
    explicitModelProvider: params.explicitModelProvider,
    modelProviderId: params.modelProviderId,
  });
  if (timings) {
    timings.matchingProviderLookup = Date.now() - matchingProviderStart;
  }

  assertProviderFresh(matchingProvider);

  const selectedModel =
    params.selectedModelOverride ??
    matchingProvider?.selectedModel ??
    undefined;
  const credentialScope: ModelProviderCredentialScope =
    matchingProvider?.userId && matchingProvider.userId !== ORG_SENTINEL_USER_ID
      ? "member"
      : "org";

  return buildResolvedModelRoute({
    source: "legacy",
    providerType,
    selectedModel,
    credentialScope,
    modelProviderId: matchingProvider?.id ?? null,
    ownerUserId: matchingProvider?.userId ?? ORG_SENTINEL_USER_ID,
    sourceProvider: matchingProvider,
  });
}

export async function resolveModelRoute(
  params: ResolveModelRouteParams,
  timings?: ResolveModelProviderSecretTimings,
): Promise<ResolvedModelRoute> {
  if (await isModelFirstModelProviderEnabled(params.orgId, params.userId)) {
    return resolveModelFirstModelRoute(params);
  }
  return resolveLegacyModelRoute(params, timings);
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
  userId: string,
  framework: string,
  hasExplicitModelProviderConfig: boolean,
  explicitModelProvider?: string,
  modelProviderId?: string,
  selectedModelOverride?: string,
  modelProviderCredentialScope?: string,
): Promise<ModelProviderSecretResult> {
  const secrets: Record<string, string> | undefined = undefined;
  const timings: ResolveModelProviderSecretTimings = {
    defaultProviderLookup: 0,
    matchingProviderLookup: 0,
  };

  // Skip if compose already declares the framework's auth env var directly.
  // Framework-agnostic: codex with explicit OPENAI_API_KEY short-circuits here
  // just like claude-code with explicit ANTHROPIC_API_KEY.
  if (hasExplicitModelProviderConfig) {
    return {
      secrets,
      injectedEnvironment: undefined,
      resolvedModelProvider: undefined,
      framework,
      timings,
    };
  }

  const route = await resolveModelRoute(
    {
      orgId,
      userId,
      framework,
      explicitModelProvider,
      modelProviderId,
      selectedModelOverride,
      modelProviderCredentialScope,
    },
    timings,
  );
  const result = await materializeModelRoute({ orgId, route, timings });
  return { ...result, timings };
}
