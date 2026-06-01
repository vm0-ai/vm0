import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorAuthCodeGrantAuthMethodId,
  type ConnectorDeviceAuthGrantAuthMethodId,
  type ConnectorAuthMethodIds,
  type ConnectorAuthMethodIdsByAccessKind,
  type ConnectorAuthMethodIdsByGrantKind,
  type ConnectorAuthMethodIdsByRevokeKind,
  type ConnectorTypesByGrantKind,
  type ConnectorAuthMethodClientConfig,
  type ConnectorAccessConfig,
  type ConnectorAccessKind,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorAuthClientConfig,
  type ConnectorDeviceAuthGrantConfig,
  type ConnectorEnvBindings,
  type ConnectorGenerationType,
  type ConnectorGrantConfig,
  type ConnectorGrantKind,
  type ConnectorManualGrantFieldConfig,
  type ConnectorRevokeKind,
  type ConnectorType,
  type AuthCodeGrantConnectorType,
  type DeviceAuthGrantConnectorType,
  type DynamicPublicConnectorAuthClientConfig,
  type RefreshTokenAccessConnectorType,
  type StaticConfidentialConnectorAuthClientConfig,
  type StaticPublicConnectorAuthClientConfig,
  type TokenRevokeConnectorType,
} from "./connectors";
import type { FeatureSwitchKey } from "./feature-switch-key";

const CONNECTOR_AUTH_METHOD_PRIORITY = {
  oauth: 0,
  "api-token": 1,
  api: 2,
} as const satisfies Record<ConnectorAuthMethodId, number>;

function connectorAuthMethodPriority(
  authMethod: ConnectorAuthMethodId,
): number {
  return CONNECTOR_AUTH_METHOD_PRIORITY[authMethod];
}

export function getConfiguredConnectorAuthMethods(
  type: ConnectorType,
): ConnectorAuthMethodId[] {
  // Configured methods are raw registry entries; callers apply feature flags.
  return Object.keys(CONNECTOR_TYPES[type].authMethods)
    .map((authMethod) => {
      return connectorAuthMethodIdSchema.parse(authMethod);
    })
    .sort((a, b) => {
      const priorityDiff =
        connectorAuthMethodPriority(a) - connectorAuthMethodPriority(b);
      return priorityDiff === 0 ? a.localeCompare(b) : priorityDiff;
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

export function getConnectorAuthMethodIdsForGrantKind<
  Type extends ConnectorType,
  Kind extends ConnectorGrantKind,
>(
  type: Type,
  grantKind: Kind,
): ConnectorAuthMethodIdsByGrantKind<Type, Kind>[] {
  return getConfiguredConnectorAuthMethods(type).filter(
    (
      authMethod,
    ): authMethod is ConnectorAuthMethodIdsByGrantKind<Type, Kind> => {
      return connectorAuthMethodHasGrantKind(type, authMethod, grantKind);
    },
  );
}

function connectorAuthMethodHasAccessKind<
  Type extends ConnectorType,
  Kind extends ConnectorAccessKind,
>(
  type: Type,
  authMethod: string,
  accessKind: Kind,
): authMethod is ConnectorAuthMethodIdsByAccessKind<Type, Kind> {
  return getConnectorAuthMethod(type, authMethod)?.access.kind === accessKind;
}

export function getConnectorAuthMethodIdsForAccessKind<
  Type extends ConnectorType,
  Kind extends ConnectorAccessKind,
>(
  type: Type,
  accessKind: Kind,
): ConnectorAuthMethodIdsByAccessKind<Type, Kind>[] {
  return getConfiguredConnectorAuthMethods(type).filter(
    (
      authMethod,
    ): authMethod is ConnectorAuthMethodIdsByAccessKind<Type, Kind> => {
      return connectorAuthMethodHasAccessKind(type, authMethod, accessKind);
    },
  );
}

function connectorAuthMethodHasRevokeKind<
  Type extends ConnectorType,
  Kind extends ConnectorRevokeKind,
>(
  type: Type,
  authMethod: string,
  revokeKind: Kind,
): authMethod is ConnectorAuthMethodIdsByRevokeKind<Type, Kind> {
  return getConnectorAuthMethod(type, authMethod)?.revoke.kind === revokeKind;
}

export function getConnectorAuthMethodIdsForRevokeKind<
  Type extends ConnectorType,
  Kind extends ConnectorRevokeKind,
>(
  type: Type,
  revokeKind: Kind,
): ConnectorAuthMethodIdsByRevokeKind<Type, Kind>[] {
  return getConfiguredConnectorAuthMethods(type).filter(
    (
      authMethod,
    ): authMethod is ConnectorAuthMethodIdsByRevokeKind<Type, Kind> => {
      return connectorAuthMethodHasRevokeKind(type, authMethod, revokeKind);
    },
  );
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

export function connectorAuthMethodHasGrantKind<
  Type extends ConnectorType,
  Kind extends ConnectorGrantKind,
>(
  type: Type,
  authMethod: string,
  grantKind: Kind,
): authMethod is ConnectorAuthMethodIdsByGrantKind<Type, Kind> {
  const method = getConnectorAuthMethod(type, authMethod);
  return method?.grant.kind === grantKind;
}

export interface ConnectorAuthMethodRef {
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
}

export type ConnectorAuthMethodRefByGrantKind<Kind extends ConnectorGrantKind> =
  {
    readonly [Type in ConnectorTypesByGrantKind<Kind>]: {
      readonly type: Type;
      readonly authMethod: ConnectorAuthMethodIdsByGrantKind<Type, Kind>;
    };
  }[ConnectorTypesByGrantKind<Kind>];

export function connectorAuthMethodRefHasGrantKind<
  Kind extends ConnectorGrantKind,
>(
  authMethodRef: ConnectorAuthMethodRef,
  grantKind: Kind,
): authMethodRef is ConnectorAuthMethodRefByGrantKind<Kind> {
  return (
    getConnectorAuthMethod(authMethodRef.type, authMethodRef.authMethod)?.grant
      .kind === grantKind
  );
}

export function getConnectorAuthMethodAuthCodeGrantConfig<
  Type extends AuthCodeGrantConnectorType,
>(
  type: Type,
  authMethod: ConnectorAuthCodeGrantAuthMethodId<Type>,
): ConnectorAuthCodeGrantConfig;
export function getConnectorAuthMethodAuthCodeGrantConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthCodeGrantConfig | undefined;
export function getConnectorAuthMethodAuthCodeGrantConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthCodeGrantConfig | undefined {
  const grant = getConnectorAuthMethod(type, authMethod)?.grant;
  return grant?.kind === "auth-code" ? grant : undefined;
}

export function getConnectorAuthMethodDeviceAuthGrantConfig<
  Type extends DeviceAuthGrantConnectorType,
>(
  type: Type,
  authMethod: ConnectorDeviceAuthGrantAuthMethodId<Type>,
): ConnectorDeviceAuthGrantConfig;
export function getConnectorAuthMethodDeviceAuthGrantConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorDeviceAuthGrantConfig | undefined;
export function getConnectorAuthMethodDeviceAuthGrantConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorDeviceAuthGrantConfig | undefined {
  const grant = getConnectorAuthMethod(type, authMethod)?.grant;
  return grant?.kind === "device-auth" ? grant : undefined;
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

export type ConnectorAuthClientForConfig<
  Client extends ConnectorAuthClientConfig,
> = Client extends StaticConfidentialConnectorAuthClientConfig
  ? StaticConfidentialConnectorAuthClient
  : Client extends StaticPublicConnectorAuthClientConfig
    ? StaticPublicConnectorAuthClient
    : Client extends DynamicPublicConnectorAuthClientConfig
      ? DynamicPublicConnectorAuthClient
      : never;

export type ConnectorAuthClientForMethod<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
> = ConnectorAuthClientForConfig<ConnectorAuthMethodClientConfig<Type, Method>>;

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

export function getConnectorAuthClientConfigForMethod<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
>(
  type: Type,
  authMethod: Method,
): ConnectorAuthMethodClientConfig<Type, Method> | undefined;
export function getConnectorAuthClientConfigForMethod(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthClientConfig | undefined;
export function getConnectorAuthClientConfigForMethod(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthClientConfig | undefined {
  return getConnectorAuthMethod(type, authMethod)?.client;
}

export function resolveConnectorAuthClient<
  Client extends ConnectorAuthClientConfig,
>(
  client: Client,
  readEnv: ConnectorEnvReader,
): ConnectorAuthClientForConfig<Client> | undefined;
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

export function resolveConnectorAuthClientForMethod<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
>(
  type: Type,
  authMethod: Method,
  readEnv: ConnectorEnvReader,
): ConnectorAuthClientForMethod<Type, Method> | undefined;
export function resolveConnectorAuthClientForMethod(
  type: ConnectorType,
  authMethod: string,
  readEnv: ConnectorEnvReader,
): ConnectorAuthClient | undefined;
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

export interface ConnectorEnvBindingEntry {
  readonly authMethod: ConnectorAuthMethodId;
  readonly envName: string;
  readonly valueRef: string;
}

/**
 * Get all configured environment binding entries across auth methods.
 *
 * This is for discovery and reverse lookup. Runtime injection must use
 * getConnectorAuthMethodEnvBindings() with the selected auth method.
 */
export function getConnectorEnvBindingEntries(
  type: ConnectorType,
): ConnectorEnvBindingEntry[] {
  const entries: ConnectorEnvBindingEntry[] = [];
  for (const authMethod of getConfiguredConnectorAuthMethods(type)) {
    const envBindings = getConnectorAuthMethodEnvBindings(type, authMethod);
    for (const [envName, valueRef] of Object.entries(envBindings)) {
      entries.push({ authMethod, envName, valueRef });
    }
  }
  return entries;
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

    const envNames = [
      ...new Set(
        getConnectorEnvBindingEntries(type)
          .filter(({ valueRef }) => {
            return valueRef === `$secrets.${secretName}`;
          })
          .map(({ envName }) => {
            return envName;
          }),
      ),
    ];

    if (envNames.length > 0) {
      return { connectorLabel: config.label, envNames };
    }
  }

  return null;
}

export function hasConnectorAuthCodeGrant(
  type: ConnectorType,
): type is AuthCodeGrantConnectorType {
  return getConnectorAuthMethodIdsForGrantKind(type, "auth-code").length > 0;
}

export function hasConnectorDeviceAuthGrant(
  type: ConnectorType,
): type is DeviceAuthGrantConnectorType {
  return getConnectorAuthMethodIdsForGrantKind(type, "device-auth").length > 0;
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
    const hasEnvName = getConnectorEnvBindingEntries(type).some(
      ({ envName }) => {
        return envName === name;
      },
    );
    if (hasEnvName) {
      return type;
    }
  }
  return null;
}
