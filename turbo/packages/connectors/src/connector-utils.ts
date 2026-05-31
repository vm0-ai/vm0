import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorAccessConfig,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorAuthClientConfig,
  type ConnectorDeviceAuthGrantConfig,
  type ConnectorEnvBindings,
  type ConnectorGenerationType,
  type ConnectorGrantConfig,
  type ConnectorGrantKind,
  type ConnectorManualGrantFieldConfig,
  type ConnectorType,
  type ConnectorAuthProviderType,
  type AuthCodeGrantConnectorType,
  type DeviceAuthGrantConnectorType,
  type RefreshTokenAccessConnectorType,
  type TokenRevokeConnectorType,
} from "./connectors";
import type { FeatureSwitchKey } from "./feature-switch-key";
export { isGoogleOAuthConnector } from "./auth-providers/oauth/google-connectors";

const CONNECTOR_AUTH_METHOD_PRIORITY = {
  oauth: 0,
  "api-token": 1,
  api: 2,
} as const satisfies Record<ConnectorAuthMethodId, number>;

function isConnectorAuthMethodId(
  authMethod: string,
): authMethod is ConnectorAuthMethodId {
  return Object.hasOwn(CONNECTOR_AUTH_METHOD_PRIORITY, authMethod);
}

export function getConfiguredConnectorAuthMethods(
  type: ConnectorType,
): ConnectorAuthMethodId[] {
  // Configured methods are raw registry entries; callers apply feature flags.
  return Object.keys(CONNECTOR_TYPES[type].authMethods)
    .filter(isConnectorAuthMethodId)
    .sort((a, b) => {
      return (
        CONNECTOR_AUTH_METHOD_PRIORITY[a] - CONNECTOR_AUTH_METHOD_PRIORITY[b]
      );
    });
}

/**
 * Connector utility vocabulary:
 *
 * - Available auth methods are user-selectable connection flows after
 *   feature-switch filtering.
 * - Runtime available connector types are connector types the current server
 *   environment can offer as connection candidates.
 * - User connected connector types come from persisted connector rows.
 * - Runtime injection happens later when a run receives environment entries, secrets,
 *   variables, and firewall context.
 */

/**
 * Get one auth method config for a connector type.
 */
export function getConnectorAuthMethod(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodConfig | undefined {
  for (const [methodId, method] of Object.entries(
    CONNECTOR_TYPES[type].authMethods,
  )) {
    if (methodId === authMethod) {
      return method;
    }
  }
  return undefined;
}

export function getConnectorAuthMethodIdForGrantKind(
  type: ConnectorType,
  grantKind: ConnectorGrantKind,
): ConnectorAuthMethodId | undefined {
  for (const authMethod of getConfiguredConnectorAuthMethods(type)) {
    if (getConnectorAuthMethod(type, authMethod)?.grant.kind === grantKind) {
      return authMethod;
    }
  }
  return undefined;
}

function connectorAuthMethodValues(
  type: ConnectorType,
): ConnectorAuthMethodConfig[] {
  return Object.values(CONNECTOR_TYPES[type].authMethods);
}

function getManualGrantFields(
  method: ConnectorAuthMethodConfig | undefined,
): Record<string, ConnectorManualGrantFieldConfig> | undefined {
  if (!method || method.grant.kind !== "manual") {
    return undefined;
  }
  return method.grant.fields;
}

export interface ManualGrantFieldNames {
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
}

function manualGrantFieldNames(
  fields: Record<string, ConnectorManualGrantFieldConfig>,
): ManualGrantFieldNames {
  const secretNames: string[] = [];
  const variableNames: string[] = [];
  for (const [name, cfg] of Object.entries(fields)) {
    if (cfg.storage === "variable") {
      variableNames.push(name);
    } else {
      secretNames.push(name);
    }
  }
  return { secrets: secretNames, variables: variableNames };
}

export function getConnectorManualGrantFieldNames(
  type: ConnectorType,
): ManualGrantFieldNames | null {
  const secretNames = new Set<string>();
  const variableNames = new Set<string>();
  for (const authMethod of getConfiguredConnectorAuthMethods(type)) {
    const method = getConnectorAuthMethod(type, authMethod);
    if (method?.grant.kind !== "manual") {
      continue;
    }
    const fields = manualGrantFieldNames(method.grant.fields);
    fields.secrets.forEach((name) => {
      secretNames.add(name);
    });
    fields.variables.forEach((name) => {
      variableNames.add(name);
    });
  }

  if (secretNames.size === 0 && variableNames.size === 0) {
    return null;
  }
  return { secrets: [...secretNames], variables: [...variableNames] };
}

function connectorAccessEnvBindings(
  access: ConnectorAccessConfig,
): ConnectorEnvBindings {
  switch (access.kind) {
    case "static":
    case "refresh-token":
      return access.envBindings;
    case "none":
      return {};
  }
}

export type ConnectorAuthMethodAccessMetadata =
  | {
      readonly kind: "static";
      readonly envBindings: ConnectorEnvBindings;
    }
  | {
      readonly kind: "refresh-token";
      readonly accessToken: string;
      readonly refreshToken: string;
      readonly envBindings: ConnectorEnvBindings;
    }
  | {
      readonly kind: "none";
      readonly envBindings: ConnectorEnvBindings;
    };

export function getConnectorAuthMethodAccessMetadata(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodAccessMetadata | undefined {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return undefined;
  }

  switch (method.access.kind) {
    case "static":
      return {
        kind: "static",
        envBindings: method.access.envBindings,
      };
    case "refresh-token":
      return {
        kind: "refresh-token",
        accessToken: method.access.accessToken,
        refreshToken: method.access.refreshToken,
        envBindings: method.access.envBindings,
      };
    case "none":
      return {
        kind: "none",
        envBindings: {},
      };
  }
}

function authMethodAccessPriority(method: ConnectorAuthMethodConfig): number {
  switch (method.grant.kind) {
    case "auth-code":
    case "device-auth":
      return 2;
    case "managed":
    case "manual":
      return 1;
  }
}

type ConnectorScopeBearingGrantConfig =
  | ConnectorAuthCodeGrantConfig
  | ConnectorDeviceAuthGrantConfig;

function isConnectorScopeBearingGrantConfig(
  method: ConnectorAuthMethodConfig,
): method is ConnectorAuthMethodConfig & {
  readonly grant: ConnectorScopeBearingGrantConfig;
} {
  switch (method.grant.kind) {
    case "auth-code":
    case "device-auth":
      return true;
    case "manual":
    case "managed":
      return false;
  }
}

function getConnectorScopeBearingGrantConfig(
  type: ConnectorAuthProviderType,
): ConnectorScopeBearingGrantConfig;
function getConnectorScopeBearingGrantConfig(
  type: ConnectorType,
): ConnectorScopeBearingGrantConfig | undefined;
function getConnectorScopeBearingGrantConfig(
  type: ConnectorType,
): ConnectorScopeBearingGrantConfig | undefined {
  for (const method of connectorAuthMethodValues(type)) {
    if (isConnectorScopeBearingGrantConfig(method)) {
      return method.grant;
    }
  }
  return undefined;
}

export function connectorAuthMethodHasGrantKind(
  type: ConnectorType,
  authMethod: string,
  grantKind: ConnectorGrantKind,
): boolean {
  const method = getConnectorAuthMethod(type, authMethod);
  return method?.grant.kind === grantKind;
}

function connectorGrantScopes(
  grant: ConnectorGrantConfig | undefined,
): readonly string[] {
  switch (grant?.kind) {
    case "auth-code":
    case "device-auth":
      return grant.scopes;
    case "manual":
    case "managed":
    case undefined:
      return [];
  }
}

export function getConnectorAuthCodeGrantConfig(
  type: AuthCodeGrantConnectorType,
): ConnectorAuthCodeGrantConfig;
export function getConnectorAuthCodeGrantConfig(
  type: ConnectorType,
): ConnectorAuthCodeGrantConfig | undefined;
export function getConnectorAuthCodeGrantConfig(
  type: ConnectorType,
): ConnectorAuthCodeGrantConfig | undefined {
  for (const method of connectorAuthMethodValues(type)) {
    switch (method.grant.kind) {
      case "auth-code":
        return method.grant;
      case "device-auth":
      case "manual":
      case "managed":
        break;
    }
  }
  return undefined;
}

export function getConnectorDeviceAuthGrantConfig(
  type: DeviceAuthGrantConnectorType,
): ConnectorDeviceAuthGrantConfig;
export function getConnectorDeviceAuthGrantConfig(
  type: ConnectorType,
): ConnectorDeviceAuthGrantConfig | undefined;
export function getConnectorDeviceAuthGrantConfig(
  type: ConnectorType,
): ConnectorDeviceAuthGrantConfig | undefined {
  for (const method of connectorAuthMethodValues(type)) {
    switch (method.grant.kind) {
      case "device-auth":
        return method.grant;
      case "auth-code":
      case "manual":
      case "managed":
        break;
    }
  }
  return undefined;
}

export function getConnectorGrantScopes(type: ConnectorType): string[] {
  return [...connectorGrantScopes(getConnectorScopeBearingGrantConfig(type))];
}

export function getConnectorAuthMethodGrantScopes(
  type: ConnectorType,
  authMethod: string,
): string[] {
  return [
    ...connectorGrantScopes(getConnectorAuthMethod(type, authMethod)?.grant),
  ];
}

export function connectorAuthMethodSupportsTokenRevoke(
  type: ConnectorType,
  authMethod: string,
): type is TokenRevokeConnectorType {
  return (
    getConnectorAuthMethod(type, authMethod)?.revoke.kind === "token-revoke"
  );
}

export function connectorAuthMethodSupportsRefreshTokenAccess(
  type: ConnectorType,
  authMethod: string,
): type is RefreshTokenAccessConnectorType {
  return (
    getConnectorAuthMethod(type, authMethod)?.access.kind === "refresh-token"
  );
}

export function getConnectorGenerationTypes(
  type: ConnectorType,
): readonly ConnectorGenerationType[] {
  const config = CONNECTOR_TYPES[type];
  return "generation" in config ? (config.generation ?? []) : [];
}

export function getConnectorTags(type: ConnectorType): readonly string[] {
  const config = CONNECTOR_TYPES[type];
  return "tags" in config ? (config.tags ?? []) : [];
}

export type ConnectorFeatureStates =
  | Partial<Record<FeatureSwitchKey, boolean>>
  | null
  | undefined;

export type ApiAuthMethodPolicy =
  | "exclude"
  | "include"
  | { readonly includeForTypes: readonly ConnectorType[] };

export interface AvailableConnectorAuthMethodsOptions {
  readonly apiAuthMethodPolicy?: ApiAuthMethodPolicy;
}

export function isConnectorAuthMethodAvailable(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
  featureStates: ConnectorFeatureStates,
): boolean {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return false;
  }
  return !method.featureFlag || !!featureStates?.[method.featureFlag];
}

function shouldIncludeApiAuthMethod(
  type: ConnectorType,
  policy: ApiAuthMethodPolicy | undefined,
): boolean {
  switch (policy) {
    case "include":
      return true;
    case "exclude":
    case undefined:
      return false;
  }
  return policy.includeForTypes.includes(type);
}

/**
 * Return user-selectable connector connection flows for a surface.
 *
 * This does not describe persisted connected state.
 */
export function getAvailableConnectorAuthMethods(
  type: ConnectorType,
  featureStates: ConnectorFeatureStates,
  options: AvailableConnectorAuthMethodsOptions = {},
): ConnectorAuthMethodId[] {
  const apiAuthMethodPolicy = options.apiAuthMethodPolicy ?? "exclude";
  const availableAuthMethods: ConnectorAuthMethodId[] = [];
  const configuredAuthMethods = getConfiguredConnectorAuthMethods(type);

  for (const authMethod of configuredAuthMethods) {
    const method = getConnectorAuthMethod(type, authMethod);
    switch (method?.grant.kind) {
      case "managed": {
        if (!shouldIncludeApiAuthMethod(type, apiAuthMethodPolicy)) {
          continue;
        }
        break;
      }
      case "auth-code":
      case "device-auth":
      case "manual": {
        break;
      }
      case undefined: {
        continue;
      }
    }
    if (isConnectorAuthMethodAvailable(type, authMethod, featureStates)) {
      availableAuthMethods.push(authMethod);
    }
  }

  return availableAuthMethods;
}

export type ConnectorEnvReader = (name: string) => string | undefined;

export type StaticConfidentialConnectorAuthClient = {
  readonly clientRegistration: "static";
  readonly clientType: "confidential";
  readonly clientId: string;
  readonly clientSecret: string;
};

export type StaticPublicConnectorAuthClient = {
  readonly clientRegistration: "static";
  readonly clientType: "public";
  readonly clientId: string;
};

export type DynamicPublicConnectorAuthClient = {
  readonly clientRegistration: "dynamic";
  readonly clientType: "public";
};

export type StaticConnectorAuthClient =
  | StaticConfidentialConnectorAuthClient
  | StaticPublicConnectorAuthClient;

export type ConnectorAuthClient =
  | StaticConnectorAuthClient
  | DynamicPublicConnectorAuthClient;

export function isStaticConnectorAuthClient(
  authClient: ConnectorAuthClient,
): authClient is StaticConnectorAuthClient {
  return authClient.clientRegistration === "static";
}

export function isStaticConfidentialConnectorAuthClient(
  authClient: ConnectorAuthClient,
): authClient is StaticConfidentialConnectorAuthClient {
  return (
    isStaticConnectorAuthClient(authClient) &&
    authClient.clientType === "confidential"
  );
}

export function getConnectorAuthClientConfigForMethod(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthClientConfig | undefined {
  return getConnectorAuthMethod(type, authMethod)?.client;
}

export function resolveConnectorAuthClient(
  client: ConnectorAuthClientConfig,
  readEnv: ConnectorEnvReader,
): ConnectorAuthClient | undefined {
  if (client.clientRegistration === "dynamic") {
    return { clientRegistration: "dynamic", clientType: "public" };
  }

  if ("clientId" in client) {
    if (client.clientType === "confidential") {
      return {
        clientRegistration: "static",
        clientType: "confidential",
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      };
    }
    return {
      clientRegistration: "static",
      clientType: "public",
      clientId: client.clientId,
    };
  }

  const clientId = readEnv(client.clientIdEnv);
  if (!clientId) {
    return undefined;
  }

  if (client.clientType === "public") {
    return { clientRegistration: "static", clientType: "public", clientId };
  }

  const clientSecret = readEnv(client.clientSecretEnv);
  if (!clientSecret) {
    return undefined;
  }

  return {
    clientRegistration: "static",
    clientType: "confidential",
    clientId,
    clientSecret,
  };
}

export function resolveConnectorAuthClientForMethod(
  type: ConnectorType,
  authMethod: string,
  readEnv: ConnectorEnvReader,
): ConnectorAuthClient | undefined {
  const clientConfig = getConnectorAuthClientConfigForMethod(type, authMethod);
  if (!clientConfig) {
    return undefined;
  }
  return resolveConnectorAuthClient(clientConfig, readEnv);
}

function hasRuntimeAvailableAuthMethod(
  readEnv: ConnectorEnvReader,
  type: ConnectorType,
): boolean {
  for (const authMethod of getConfiguredConnectorAuthMethods(type)) {
    const method = getConnectorAuthMethod(type, authMethod);
    switch (method?.grant.kind) {
      case "auth-code":
      case "device-auth": {
        if (resolveConnectorAuthClientForMethod(type, authMethod, readEnv)) {
          return true;
        }
        break;
      }
      case "manual": {
        return true;
      }
      case "managed":
      case undefined: {
        break;
      }
    }
  }
  return false;
}

/**
 * Return connector types the current runtime can offer as connection candidates.
 *
 * This is not user connected state and it does not evaluate feature switches.
 * It includes connectors with user-entered manual grant methods because they
 * do not require a server auth client, while auth-provider methods require
 * their runtime client env to exist unless their client config is static inline.
 */
export function getRuntimeAvailableConnectorTypes(
  readEnv: ConnectorEnvReader,
): ConnectorType[] {
  const runtimeAvailable = new Set<ConnectorType>();

  for (const type of CONNECTOR_TYPE_KEYS) {
    if (hasRuntimeAvailableAuthMethod(readEnv, type)) {
      runtimeAvailable.add(type);
    }
  }

  return [...runtimeAvailable].sort();
}

/**
 * Get secret names for a specific auth method
 */
export function getConnectorSecretNames(
  type: ConnectorType,
  authMethod: string,
): string[] {
  return connectorMethodSecretNames(getConnectorAuthMethod(type, authMethod));
}

/**
 * Get variable names for a specific auth method
 */
export function getConnectorVariableNames(
  type: ConnectorType,
  authMethod: string,
): string[] {
  return connectorMethodVariableNames(getConnectorAuthMethod(type, authMethod));
}

function connectorMethodSecretNames(
  method: ConnectorAuthMethodConfig | undefined,
): string[] {
  if (!method) {
    return [];
  }

  const names = new Set<string>();
  const fields = getManualGrantFields(method);
  for (const [name, field] of Object.entries(fields ?? {})) {
    if (field.storage !== "variable") {
      names.add(name);
    }
  }

  for (const valueRef of Object.values(
    connectorAccessEnvBindings(method.access),
  )) {
    if (valueRef.startsWith("$secrets.")) {
      names.add(valueRef.slice("$secrets.".length));
    }
  }

  if (method.access.kind === "refresh-token") {
    names.add(method.access.accessToken);
    names.add(method.access.refreshToken);
  }

  return [...names];
}

function connectorMethodVariableNames(
  method: ConnectorAuthMethodConfig | undefined,
): string[] {
  if (!method) {
    return [];
  }

  const names = new Set<string>();
  const fields = getManualGrantFields(method);
  for (const [name, field] of Object.entries(fields ?? {})) {
    if (field.storage === "variable") {
      names.add(name);
    }
  }

  for (const valueRef of Object.values(
    connectorAccessEnvBindings(method.access),
  )) {
    if (valueRef.startsWith("$vars.")) {
      names.add(valueRef.slice("$vars.".length));
    }
  }

  return [...names];
}

/**
 * Get runtime environment bindings for a specific connector auth method.
 */
export function getConnectorAuthMethodEnvBindings(
  type: ConnectorType,
  authMethod: string,
): ConnectorEnvBindings {
  const method = getConnectorAuthMethod(type, authMethod);
  return method ? connectorAccessEnvBindings(method.access) : {};
}

/**
 * Get runtime environment bindings for a connector type.
 */
export function getConnectorEnvBindings(
  type: ConnectorType,
): ConnectorEnvBindings {
  const methods = connectorAuthMethodValues(type).sort((a, b) => {
    return authMethodAccessPriority(a) - authMethodAccessPriority(b);
  });
  const envBindings: ConnectorEnvBindings = {};
  for (const method of methods) {
    Object.assign(envBindings, connectorAccessEnvBindings(method.access));
  }
  return envBindings;
}

/**
 * Get connector label and derived environment names for a connector secret.
 * Performs a reverse lookup from secret name to the connector type and
 * env bindings that reference it.
 *
 * Example: getConnectorEnvNamesForSecret("GITHUB_ACCESS_TOKEN")
 * → { connectorLabel: "GitHub", envNames: ["GH_TOKEN", "GITHUB_TOKEN"] }
 */
export function getConnectorEnvNamesForSecret(
  secretName: string,
): { connectorLabel: string; envNames: string[] } | null {
  const allTypes = CONNECTOR_TYPE_KEYS;

  for (const type of allTypes) {
    const config = CONNECTOR_TYPES[type];

    const found = Object.values(config.authMethods).some((method) => {
      return connectorMethodSecretNames(method).includes(secretName);
    });
    if (!found) {
      continue;
    }

    // Find all environment names that reference this secret.
    const envBindings = getConnectorEnvBindings(type);
    const envNames = Object.entries(envBindings)
      .filter(([, valueRef]) => {
        return valueRef === `$secrets.${secretName}`;
      })
      .map(([envName]) => {
        return envName;
      });

    if (envNames.length > 0) {
      return { connectorLabel: config.label, envNames };
    }
  }

  return null;
}

export function hasConnectorAuthCodeGrant(
  type: ConnectorType,
): type is AuthCodeGrantConnectorType {
  return getConnectorAuthCodeGrantConfig(type) !== undefined;
}

export function hasConnectorDeviceAuthGrant(
  type: ConnectorType,
): type is DeviceAuthGrantConnectorType {
  return getConnectorDeviceAuthGrantConfig(type) !== undefined;
}

function hasRequiredGrantScopes(
  requiredScopes: readonly string[],
  storedScopes: string[] | null,
): boolean {
  if (requiredScopes.length === 0) return true;
  if (!storedScopes) return false;
  const storedSet = new Set(storedScopes);
  return requiredScopes.every((s) => {
    return storedSet.has(s);
  });
}

/**
 * Compute the diff between currently required scopes and stored scopes for a connector.
 */
export interface ScopeDiff {
  addedScopes: string[];
  removedScopes: string[];
  currentScopes: string[];
  storedScopes: string[];
}

function scopeDiff(
  currentScopes: readonly string[],
  storedScopes: string[] | null,
): ScopeDiff {
  const stored = storedScopes ?? [];
  const storedSet = new Set(stored);
  const currentSet = new Set(currentScopes);

  return {
    addedScopes: currentScopes.filter((s) => {
      return !storedSet.has(s);
    }),
    removedScopes: stored.filter((s) => {
      return !currentSet.has(s);
    }),
    currentScopes: [...currentScopes],
    storedScopes: stored,
  };
}

/**
 * Check if stored scopes cover all currently required scopes for the first
 * scope-bearing grant on a connector type.
 */
export function hasRequiredScopes(
  connectorType: ConnectorType,
  storedScopes: string[] | null,
): boolean {
  return hasRequiredGrantScopes(
    getConnectorGrantScopes(connectorType),
    storedScopes,
  );
}

export function hasRequiredConnectorAuthMethodScopes(
  connectorType: ConnectorType,
  authMethod: string,
  storedScopes: string[] | null,
): boolean {
  return hasRequiredGrantScopes(
    getConnectorAuthMethodGrantScopes(connectorType, authMethod),
    storedScopes,
  );
}

/**
 * Compute the diff between currently required scopes and stored scopes for the
 * first scope-bearing grant on a connector type.
 */
export function getScopeDiff(
  connectorType: ConnectorType,
  storedScopes: string[] | null,
): ScopeDiff {
  return scopeDiff(getConnectorGrantScopes(connectorType), storedScopes);
}

export function getConnectorAuthMethodScopeDiff(
  connectorType: ConnectorType,
  authMethod: string,
  storedScopes: string[] | null,
): ScopeDiff {
  return scopeDiff(
    getConnectorAuthMethodGrantScopes(connectorType, authMethod),
    storedScopes,
  );
}

/**
 * Reverse lookup: given a secret/environment name, find which connector type manages it.
 * Checks manual grant fields, access storage names, and env binding names.
 * Returns null if no connector manages this name.
 */
export function getConnectorTypeForSecretName(
  name: string,
): ConnectorType | null {
  const allTypes = CONNECTOR_TYPE_KEYS;
  for (const type of allTypes) {
    const config = CONNECTOR_TYPES[type];
    for (const method of Object.values(config.authMethods)) {
      if (name in (getManualGrantFields(method) ?? {})) {
        return type;
      }
    }
    for (const method of Object.values(config.authMethods)) {
      if (connectorMethodSecretNames(method).includes(name)) {
        return type;
      }
    }
    // Check envBindings names
    const envBindings = getConnectorEnvBindings(type);
    if (name in envBindings) {
      return type;
    }
  }
  return null;
}
