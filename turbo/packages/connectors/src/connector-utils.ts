import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorAccessConfig,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorDeviceAuthGrantConfig,
  type ConnectorEnvBindings,
  type ConnectorGenerationType,
  type ConnectorOAuthClientConfig,
  type ConnectorManualGrantFieldConfig,
  type ConnectorType,
  type OAuthGrantConnectorType,
  type AuthCodeGrantConnectorType,
  type DeviceAuthGrantConnectorType,
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
 * - User connected connector types come from persisted rows or inferred manual
 *   credential state from user secrets and variables.
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

export interface ConnectedManualGrantMethod {
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
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

function requiredManualGrantFieldNames(
  fields: Record<string, ConnectorManualGrantFieldConfig>,
): ManualGrantFieldNames {
  const secretNames: string[] = [];
  const variableNames: string[] = [];
  for (const [name, cfg] of Object.entries(fields)) {
    if (!cfg.required) continue;
    if (cfg.storage === "variable") {
      variableNames.push(name);
    } else {
      secretNames.push(name);
    }
  }
  return { secrets: secretNames, variables: variableNames };
}

function hasRequiredManualGrantFields(fields: ManualGrantFieldNames): boolean {
  return fields.secrets.length > 0 || fields.variables.length > 0;
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

export function deriveConnectedManualGrantMethod(
  type: ConnectorType,
  userSecretNames: Set<string>,
  userVariableNames?: Set<string>,
): ConnectedManualGrantMethod | null {
  const varNames = userVariableNames ?? new Set<string>();

  for (const authMethod of getConfiguredConnectorAuthMethods(type)) {
    const method = getConnectorAuthMethod(type, authMethod);
    if (method?.grant.kind !== "manual") {
      continue;
    }
    const requiredFields = requiredManualGrantFieldNames(method.grant.fields);
    if (!hasRequiredManualGrantFields(requiredFields)) {
      continue;
    }
    const secretsOk = requiredFields.secrets.every((name) => {
      return userSecretNames.has(name);
    });
    const variablesOk = requiredFields.variables.every((name) => {
      return varNames.has(name);
    });
    if (secretsOk && variablesOk) {
      return {
        type,
        authMethod,
      };
    }
  }

  return null;
}

export function deriveConnectedManualGrantMethods(
  userSecretNames: Set<string>,
  userVariableNames?: Set<string>,
): ConnectedManualGrantMethod[] {
  const connected: ConnectedManualGrantMethod[] = [];

  for (const type of CONNECTOR_TYPE_KEYS) {
    const method = deriveConnectedManualGrantMethod(
      type,
      userSecretNames,
      userVariableNames,
    );
    if (method) {
      connected.push(method);
    }
  }

  return connected;
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

type ConnectorOAuthGrantConfig =
  | ConnectorAuthCodeGrantConfig
  | ConnectorDeviceAuthGrantConfig;

function isConnectorOAuthGrantConfig(
  method: ConnectorAuthMethodConfig,
): method is ConnectorAuthMethodConfig & {
  readonly grant: ConnectorOAuthGrantConfig;
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

function getConnectorOAuthGrantConfig(
  type: OAuthGrantConnectorType,
): ConnectorOAuthGrantConfig;
function getConnectorOAuthGrantConfig(
  type: ConnectorType,
): ConnectorOAuthGrantConfig | undefined;
function getConnectorOAuthGrantConfig(
  type: ConnectorType,
): ConnectorOAuthGrantConfig | undefined {
  for (const method of connectorAuthMethodValues(type)) {
    if (isConnectorOAuthGrantConfig(method)) {
      return method.grant;
    }
  }
  return undefined;
}

export function hasConnectorOAuthGrant(
  type: ConnectorType,
): type is OAuthGrantConnectorType {
  return getConnectorOAuthGrantConfig(type) !== undefined;
}

export function connectorAuthMethodHasOAuthGrant(
  type: ConnectorType,
  authMethod: string,
): boolean {
  const method = getConnectorAuthMethod(type, authMethod);
  switch (method?.grant.kind) {
    case "auth-code":
    case "device-auth":
      return true;
    case "manual":
    case "managed":
    case undefined:
      return false;
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

export function getConnectorOAuthScopes(type: ConnectorType): string[] {
  return [...(getConnectorOAuthGrantConfig(type)?.scopes ?? [])];
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

export type StaticConfidentialConnectorOAuthClient = {
  readonly clientRegistration: "static";
  readonly clientType: "confidential";
  readonly clientId: string;
  readonly clientSecret: string;
};

export type StaticPublicConnectorOAuthClient = {
  readonly clientRegistration: "static";
  readonly clientType: "public";
  readonly clientId: string;
};

export type DynamicPublicConnectorOAuthClient = {
  readonly clientRegistration: "dynamic";
  readonly clientType: "public";
};

export type StaticConnectorOAuthClient =
  | StaticConfidentialConnectorOAuthClient
  | StaticPublicConnectorOAuthClient;

export type ConnectorOAuthClient =
  | StaticConnectorOAuthClient
  | DynamicPublicConnectorOAuthClient;

export function isStaticConnectorOAuthClient(
  oauthClient: ConnectorOAuthClient,
): oauthClient is StaticConnectorOAuthClient {
  return oauthClient.clientRegistration === "static";
}

export function isStaticConfidentialConnectorOAuthClient(
  oauthClient: ConnectorOAuthClient,
): oauthClient is StaticConfidentialConnectorOAuthClient {
  return (
    isStaticConnectorOAuthClient(oauthClient) &&
    oauthClient.clientType === "confidential"
  );
}

function getConnectorOAuthClientConfig(
  type: OAuthGrantConnectorType,
): ConnectorOAuthClientConfig;
function getConnectorOAuthClientConfig(
  type: ConnectorType,
): ConnectorOAuthClientConfig | undefined;
function getConnectorOAuthClientConfig(
  type: ConnectorType,
): ConnectorOAuthClientConfig | undefined {
  return getConnectorOAuthGrantConfig(type)?.client;
}

function resolveConnectorOAuthClient(
  client: ConnectorOAuthClientConfig,
  readEnv: ConnectorEnvReader,
): ConnectorOAuthClient | undefined {
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

export function getConnectorOAuthClient(
  type: ConnectorType,
  readEnv: ConnectorEnvReader,
): ConnectorOAuthClient | undefined {
  const client = getConnectorOAuthClientConfig(type);
  if (!client) {
    return undefined;
  }
  return resolveConnectorOAuthClient(client, readEnv);
}

function hasConfiguredOAuth(
  readEnv: ConnectorEnvReader,
  type: ConnectorType,
): boolean {
  return getConnectorOAuthClient(type, readEnv) !== undefined;
}

/**
 * Return connector types the current runtime can offer as connection candidates.
 *
 * This is not user connected state and it does not evaluate feature switches.
 * It includes connectors with user-entered manual grant methods because they
 * do not require a server OAuth client, while OAuth connectors require their
 * runtime OAuth client env to exist unless their client config is static inline.
 */
export function getRuntimeAvailableConnectorTypes(
  readEnv: ConnectorEnvReader,
): ConnectorType[] {
  const runtimeAvailable = new Set<ConnectorType>();

  for (const type of CONNECTOR_TYPE_KEYS) {
    if (
      hasConfiguredOAuth(readEnv, type) ||
      connectorAuthMethodValues(type).some((method) => {
        return method.grant.kind === "manual";
      })
    ) {
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

/**
 * Get the set of environment names that connected connectors can provide.
 * Used by pre-run checks to exclude connector-provided secrets from "missing" lists.
 *
 * Example: getConnectorProvidedEnvNames(["github"])
 * → Set { "GH_TOKEN", "GITHUB_TOKEN" }
 */
export function getConnectorProvidedEnvNames(
  connectedTypes: string[],
): Set<string> {
  const provided = new Set<string>();

  for (const rawType of connectedTypes) {
    const parsed = connectorTypeSchema.safeParse(rawType);
    if (!parsed.success) {
      continue;
    }
    const envBindings = getConnectorEnvBindings(parsed.data);
    for (const envName of Object.keys(envBindings)) {
      provided.add(envName);
    }
  }

  return provided;
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

/**
 * Check if stored OAuth scopes cover all required scopes for a connector type.
 * Returns true if no OAuth config exists (non-OAuth connector) or all required scopes are present.
 * Returns false if storedScopes is null (legacy connector) or missing any required scope.
 */
export function hasRequiredScopes(
  connectorType: ConnectorType,
  storedScopes: string[] | null,
): boolean {
  const scopes = getConnectorOAuthGrantConfig(connectorType)?.scopes;
  if (!scopes) return true;
  if (scopes.length === 0) return true;
  if (!storedScopes) return false;
  const storedSet = new Set(storedScopes);
  return scopes.every((s) => {
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

export function getScopeDiff(
  connectorType: ConnectorType,
  storedScopes: string[] | null,
): ScopeDiff {
  const currentScopes = [
    ...(getConnectorOAuthGrantConfig(connectorType)?.scopes ?? []),
  ];
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
    currentScopes,
    storedScopes: stored,
  };
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
