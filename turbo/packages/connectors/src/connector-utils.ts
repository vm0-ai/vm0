import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorAccessConfig,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorConfig,
  type ConnectorDeviceAuthGrantConfig,
  type ConnectorGenerationType,
  type ConnectorInteractivePairingGrantConfig,
  type DynamicPublicConnectorOAuthClientConfig,
  type ConnectorOAuthClientConfig,
  type ConnectorManualGrantFieldConfig,
  type StaticConfidentialConnectorOAuthClientConfig,
  type StaticPublicConnectorOAuthClientConfig,
  type ConnectorType,
  type OAuthAuthCodeConnectorType,
  type OAuthDeviceAuthConnectorType,
} from "./connectors";
import type { FeatureSwitchKey } from "./feature-switch-key";
export { isGoogleOAuthConnector } from "./auth-providers/oauth/google-connectors";

const CONNECTOR_AUTH_METHOD_PRIORITY = {
  oauth: 0,
  "api-token": 1,
  api: 2,
  "cli-auth": 3,
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
 * - Runtime injection happens later when a run receives env vars, secrets,
 *   variables, and firewall context.
 */

/**
 * Get auth methods for a connector type
 */
export function getConnectorAuthMethods(
  type: ConnectorType,
): Partial<Record<ConnectorAuthMethodId, ConnectorAuthMethodConfig>> {
  return CONNECTOR_TYPES[type].authMethods;
}

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

function getConnectorRequiredManualGrantFields(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): ManualGrantFieldNames | null {
  const fields = getManualGrantFields(getConnectorAuthMethod(type, authMethod));
  return fields ? requiredManualGrantFieldNames(fields) : null;
}

function getConnectorManualGrantFieldStorageType(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
  name: string,
): "secret" | "variable" {
  const fieldConfig = getManualGrantFields(
    getConnectorAuthMethod(type, authMethod),
  )?.[name];
  return fieldConfig?.storage ?? "secret";
}

export function getConnectorManualGrantFields(
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

function connectorAccessOutputs(
  access: ConnectorAccessConfig,
): Record<string, string> {
  switch (access.kind) {
    case "static":
    case "refresh-token":
    case "credential-exchange":
      return access.outputs;
    case "managed":
      return access.outputs ?? {};
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
    case "interactive-pairing":
      return 0;
  }
}

export type ConnectorOAuthGrantConfig =
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
    case "interactive-pairing":
      return false;
  }
}

export function getConnectorOAuthGrantConfigIfSupported(
  type: ConnectorType,
): ConnectorOAuthGrantConfig | undefined {
  for (const method of connectorAuthMethodValues(type)) {
    if (isConnectorOAuthGrantConfig(method)) {
      return method.grant;
    }
  }
  return undefined;
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
    case "interactive-pairing":
    case undefined:
      return false;
  }
}

function isConnectorInteractivePairingGrantConfig(
  method: ConnectorAuthMethodConfig,
): method is ConnectorAuthMethodConfig & {
  readonly grant: ConnectorInteractivePairingGrantConfig;
} {
  switch (method.grant.kind) {
    case "interactive-pairing":
      return true;
    case "manual":
    case "auth-code":
    case "device-auth":
    case "managed":
      return false;
  }
}

export function getConnectorAuthCodeGrantConfigIfSupported(
  type: ConnectorType,
): ConnectorAuthCodeGrantConfig | undefined {
  const grant = getConnectorOAuthGrantConfigIfSupported(type);
  switch (grant?.kind) {
    case "auth-code":
      return grant;
    case "device-auth":
    case undefined:
      return undefined;
  }
}

export function getConnectorDeviceAuthGrantConfigIfSupported(
  type: ConnectorType,
): ConnectorDeviceAuthGrantConfig | undefined {
  const grant = getConnectorOAuthGrantConfigIfSupported(type);
  switch (grant?.kind) {
    case "device-auth":
      return grant;
    case "auth-code":
    case undefined:
      return undefined;
  }
}

export function getConnectorOAuthScopes(type: ConnectorType): string[] {
  return [...(getConnectorOAuthGrantConfigIfSupported(type)?.scopes ?? [])];
}

export function getConnectorInteractivePairingGrantConfigIfSupported(
  type: ConnectorType,
): ConnectorInteractivePairingGrantConfig | undefined {
  for (const method of connectorAuthMethodValues(type)) {
    if (isConnectorInteractivePairingGrantConfig(method)) {
      return method.grant;
    }
  }
  return undefined;
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
 * This does not describe persisted connected state. For example, a `cli-auth`
 * flow can import an API key and still appear as `api-token` once connected.
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
      case "interactive-pairing":
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

export interface ConnectorOAuthEnvKeys {
  readonly clientId: string;
  readonly clientSecret?: string;
}

export type UnconfiguredConnectorOAuthCredentials = {
  readonly configured: false;
  readonly client: ConnectorOAuthClientConfig;
};

export type StaticConfidentialConnectorOAuthCredentials = {
  readonly configured: true;
  readonly client: StaticConfidentialConnectorOAuthClientConfig;
  readonly clientId: string;
  readonly clientSecret: string;
};

export type StaticPublicConnectorOAuthCredentials = {
  readonly configured: true;
  readonly client: StaticPublicConnectorOAuthClientConfig;
  readonly clientId: string;
};

export type DynamicPublicConnectorOAuthCredentials = {
  readonly configured: true;
  readonly client: DynamicPublicConnectorOAuthClientConfig;
};

export type StaticConnectorOAuthCredentials =
  | StaticConfidentialConnectorOAuthCredentials
  | StaticPublicConnectorOAuthCredentials;

export type ConnectorOAuthCredentials =
  | UnconfiguredConnectorOAuthCredentials
  | StaticConnectorOAuthCredentials
  | DynamicPublicConnectorOAuthCredentials;

export function isStaticConnectorOAuthCredentials(
  credentials: ConnectorOAuthCredentials,
): credentials is StaticConnectorOAuthCredentials {
  return (
    credentials.configured && credentials.client.clientRegistration === "static"
  );
}

export function isStaticConfidentialConnectorOAuthCredentials(
  credentials: ConnectorOAuthCredentials,
): credentials is StaticConfidentialConnectorOAuthCredentials {
  return (
    isStaticConnectorOAuthCredentials(credentials) &&
    credentials.client.clientType === "confidential"
  );
}

function hasEnvValue(readEnv: ConnectorEnvReader, name: string): boolean {
  return Boolean(readEnv(name));
}

export function getConnectorOAuthClientConfig(
  type: ConnectorType,
): ConnectorOAuthClientConfig | undefined {
  return getConnectorOAuthGrantConfigIfSupported(type)?.client;
}

export function resolveConnectorOAuthClientCredentials(
  client: ConnectorOAuthClientConfig,
  readEnv: ConnectorEnvReader,
): ConnectorOAuthCredentials {
  if (client.clientRegistration === "dynamic") {
    return { configured: true, client };
  }

  if ("clientId" in client) {
    if (client.clientType === "confidential") {
      return {
        configured: true,
        client,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      };
    }
    return { configured: true, client, clientId: client.clientId };
  }

  const clientId = readEnv(client.clientIdEnv);
  if (!clientId) {
    return { configured: false, client };
  }

  if (client.clientType === "public") {
    return { configured: true, client, clientId };
  }

  const clientSecret = readEnv(client.clientSecretEnv);
  if (!clientSecret) {
    return { configured: false, client };
  }

  return { configured: true, client, clientId, clientSecret };
}

export function getConnectorOAuthCredentials(
  type: ConnectorType,
  readEnv: ConnectorEnvReader,
): ConnectorOAuthCredentials | undefined {
  const client = getConnectorOAuthClientConfig(type);
  if (!client) {
    return undefined;
  }
  return resolveConnectorOAuthClientCredentials(client, readEnv);
}

function hasConfiguredOAuth(
  readEnv: ConnectorEnvReader,
  type: ConnectorType,
): boolean {
  return getConnectorOAuthCredentials(type, readEnv)?.configured ?? false;
}

export function getConnectorOAuthEnvKeys(
  type: ConnectorType,
): ConnectorOAuthEnvKeys | undefined {
  const client = getConnectorOAuthClientConfig(type);
  if (
    !client ||
    client.clientRegistration !== "static" ||
    !("clientIdEnv" in client)
  ) {
    return undefined;
  }
  return {
    clientId: client.clientIdEnv,
    clientSecret:
      client.clientType === "confidential" ? client.clientSecretEnv : undefined,
  };
}

/**
 * Return connector types the current runtime can offer as connection candidates.
 *
 * This is not user connected state and it does not evaluate feature switches.
 * It includes connectors with user-entered manual grant methods because they
 * do not require server credentials, while OAuth connectors require their
 * runtime OAuth env to exist unless their client config is static inline.
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

  if (
    hasEnvValue(readEnv, "NGROK_API_KEY") &&
    hasEnvValue(readEnv, "NGROK_COMPUTER_CONNECTOR_DOMAIN")
  ) {
    runtimeAvailable.add("computer");
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

  for (const valueRef of Object.values(connectorAccessOutputs(method.access))) {
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
 * Get environment mapping for a connector type.
 */
export function getConnectorEnvironmentMapping(
  type: ConnectorType,
): Record<string, string> {
  const methods = connectorAuthMethodValues(type).sort((a, b) => {
    return authMethodAccessPriority(a) - authMethodAccessPriority(b);
  });
  const mapping: Record<string, string> = {};
  for (const method of methods) {
    Object.assign(mapping, connectorAccessOutputs(method.access));
  }
  return mapping;
}

/**
 * Connector types eligible for agent compose without runtime feature context:
 * include connectors with at least one always-available connection flow.
 */
export function getEligibleConnectorTypes(): string[] {
  return CONNECTOR_TYPE_KEYS.filter((type) => {
    const config = CONNECTOR_TYPES[type];
    return Object.values(config.authMethods).some((method) => {
      return !method.featureFlag;
    });
  });
}

/**
 * Get connector label and derived env var names for a connector secret.
 * Performs a reverse lookup from secret name to the connector type and
 * environment mapping that references it.
 *
 * Example: getConnectorDerivedNames("GITHUB_ACCESS_TOKEN")
 * → { connectorLabel: "GitHub", envVarNames: ["GH_TOKEN", "GITHUB_TOKEN"] }
 */
export function getConnectorDerivedNames(
  secretName: string,
): { connectorLabel: string; envVarNames: string[] } | null {
  const allTypes = CONNECTOR_TYPE_KEYS;

  for (const type of allTypes) {
    const config = CONNECTOR_TYPES[type];

    const found = Object.values(config.authMethods).some((method) => {
      return connectorMethodSecretNames(method).includes(secretName);
    });
    if (!found) {
      continue;
    }

    // Find all env var names that reference this secret
    const mapping = getConnectorEnvironmentMapping(type);
    const envVarNames = Object.entries(mapping)
      .filter(([, valueRef]) => {
        return valueRef === `$secrets.${secretName}`;
      })
      .map(([envVar]) => {
        return envVar;
      });

    if (envVarNames.length > 0) {
      return { connectorLabel: config.label, envVarNames };
    }
  }

  return null;
}

/**
 * Get the set of environment variable names that connected connectors can provide.
 * Used by pre-run checks to exclude connector-provided secrets from "missing" lists.
 *
 * Example: getConnectorProvidedSecretNames(["github"])
 * → Set { "GH_TOKEN", "GITHUB_TOKEN" }
 */
export function getConnectorProvidedSecretNames(
  connectedTypes: string[],
): Set<string> {
  const provided = new Set<string>();

  for (const rawType of connectedTypes) {
    const parsed = connectorTypeSchema.safeParse(rawType);
    if (!parsed.success) {
      continue;
    }
    const mapping = getConnectorEnvironmentMapping(parsed.data);
    for (const envVar of Object.keys(mapping)) {
      provided.add(envVar);
    }
  }

  return provided;
}

export function isOAuthAuthCodeConnectorType(
  type: ConnectorType,
): type is OAuthAuthCodeConnectorType {
  return getConnectorOAuthGrantConfigIfSupported(type)?.kind === "auth-code";
}

export function isOAuthDeviceAuthConnectorType(
  type: ConnectorType,
): type is OAuthDeviceAuthConnectorType {
  return getConnectorOAuthGrantConfigIfSupported(type)?.kind === "device-auth";
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
  const scopes = getConnectorOAuthGrantConfigIfSupported(connectorType)?.scopes;
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
    ...(getConnectorOAuthGrantConfigIfSupported(connectorType)?.scopes ?? []),
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
 * Get all secret/variable names managed by connectors across ALL auth methods.
 * Unlike `getConnectorProvidedSecretNames` (which only reads environmentMapping),
 * this function also includes api-token auth method secrets.
 *
 * Used to hide connector-managed secrets from the secrets & variables list.
 */
export function getConnectorManagedSecretNames(
  types: ConnectorType[],
): Set<string> {
  const managed = new Set<string>();
  for (const type of types) {
    const config = CONNECTOR_TYPES[type];
    for (const method of Object.values(config.authMethods)) {
      for (const name of Object.keys(getManualGrantFields(method) ?? {})) {
        managed.add(name);
      }
    }
    for (const method of Object.values(config.authMethods)) {
      for (const name of connectorMethodSecretNames(method)) {
        managed.add(name);
      }
    }
    // Also include environmentMapping keys (OAuth-derived env vars like GH_TOKEN)
    const mapping = getConnectorEnvironmentMapping(type);
    for (const envVar of Object.keys(mapping)) {
      managed.add(envVar);
    }
  }
  return managed;
}

/**
 * Reverse lookup: given a secret/env-var name, find which connector type manages it.
 * Checks manual grant fields, access storage names, and environment mapping keys.
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
    // Check environmentMapping keys
    const mapping = getConnectorEnvironmentMapping(type);
    if (name in mapping) {
      return type;
    }
  }
  return null;
}

export function getApiTokenFieldsByType(
  type: ConnectorType,
): ManualGrantFieldNames | null {
  // Compatibility wrapper for legacy API-token callers. New state inference
  // should use manual grant helpers so the method id is preserved.
  return getConnectorRequiredManualGrantFields(type, "api-token");
}

export function getApiTokenFieldStorageType(
  type: ConnectorType,
  name: string,
): "secret" | "variable" {
  // Unknown fields preserve the historical form-submit behavior and are treated
  // as encrypted secrets by the manual grant storage helper.
  return getConnectorManualGrantFieldStorageType(type, "api-token", name);
}

export function deriveApiTokenConnectedTypes(
  userSecretNames: Set<string>,
  userVariableNames?: Set<string>,
): ConnectorType[] {
  // Compatibility wrapper for legacy API-token callers. The config-driven
  // helper carries authMethod for production state inference.
  return deriveConnectedManualGrantMethods(userSecretNames, userVariableNames)
    .filter((method) => {
      return method.authMethod === "api-token";
    })
    .map((method) => {
      return method.type;
    });
}

/**
 * Result of a connector search hit, one per matched connector type.
 */
export interface ConnectorSearchResult {
  readonly type: ConnectorType;
  readonly score: number;
  /** Short label describing the matched field (e.g. "type", "env:GH_TOKEN", "tag:vcs", "token:gh"). */
  readonly matchedField: string;
}

export interface ConnectorSearchOutput {
  /** Results sorted by score desc then type asc, already capped at `limit`. */
  readonly results: readonly ConnectorSearchResult[];
  /** Total candidates above the minimum threshold, before applying `limit`. */
  readonly total: number;
}

const TOKEN_BOUNDARY = /[_\-\s]+/;
const CASE_BOUNDARY = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const MIN_SCORE = 10;

/**
 * Split a string into lowercase tokens on `_`, `-`, whitespace, and
 * camel/Pascal case boundaries. Digits stay attached to the preceding letters
 * (e.g. `v2`). Empty tokens are dropped and duplicates deduped.
 */
function tokenize(input: string): Set<string> {
  const tokens = new Set<string>();
  for (const chunk of input.split(TOKEN_BOUNDARY)) {
    if (!chunk) continue;
    for (const sub of chunk.split(CASE_BOUNDARY)) {
      const lower = sub.toLowerCase();
      if (lower) tokens.add(lower);
    }
  }
  return tokens;
}

function listSecretNames(config: ConnectorConfig): string[] {
  const names: string[] = [];
  for (const method of Object.values(config.authMethods)) {
    for (const name of Object.keys(getManualGrantFields(method) ?? {})) {
      names.push(name);
    }
    for (const valueRef of Object.values(
      connectorAccessOutputs(method.access),
    )) {
      if (valueRef.startsWith("$secrets.")) {
        names.push(valueRef.slice("$secrets.".length));
      }
    }
  }
  return names;
}

type ScoreHit = { score: number; matchedField: string };

function findExactMatch(
  keywordLower: string,
  type: ConnectorType,
  config: ConnectorConfig,
): ScoreHit | null {
  if (type.toLowerCase() === keywordLower) {
    return { score: 100, matchedField: "type" };
  }
  for (const envVar of Object.keys(getConnectorEnvironmentMapping(type))) {
    if (envVar.toLowerCase() === keywordLower) {
      return { score: 90, matchedField: `env:${envVar}` };
    }
  }
  if (config.label.toLowerCase() === keywordLower) {
    return { score: 80, matchedField: "label" };
  }
  const tags = config.tags ?? [];
  for (const tag of tags) {
    if (tag === keywordLower) {
      return { score: 70, matchedField: `tag:${tag}` };
    }
  }
  return null;
}

function findSubstringMatch(
  keywordLower: string,
  type: ConnectorType,
  config: ConnectorConfig,
): ScoreHit | null {
  if (type.toLowerCase().includes(keywordLower)) {
    return { score: 50, matchedField: "type" };
  }
  if (config.label.toLowerCase().includes(keywordLower)) {
    return { score: 50, matchedField: "label" };
  }
  for (const envVar of Object.keys(getConnectorEnvironmentMapping(type))) {
    if (envVar.toLowerCase().includes(keywordLower)) {
      return { score: 40, matchedField: `env:${envVar}` };
    }
  }
  for (const name of listSecretNames(config)) {
    if (name.toLowerCase().includes(keywordLower)) {
      return { score: 30, matchedField: `secret:${name}` };
    }
  }
  const tags = config.tags ?? [];
  for (const tag of tags) {
    if (tag.includes(keywordLower)) {
      return { score: 25, matchedField: `tag:${tag}` };
    }
  }
  return null;
}

function collectCandidateTokens(
  type: ConnectorType,
  config: ConnectorConfig,
): Set<string> {
  const tokens = new Set<string>();
  const sources = [
    type,
    config.label,
    ...Object.keys(getConnectorEnvironmentMapping(type)),
    ...listSecretNames(config),
    ...(config.tags ?? []),
  ];
  for (const source of sources) {
    for (const token of tokenize(source)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function findTokenIntersection(
  keywordTokens: Set<string>,
  type: ConnectorType,
  config: ConnectorConfig,
): ScoreHit | null {
  const candidateTokens = collectCandidateTokens(type, config);
  let intersection = 0;
  let firstCommon = "";
  for (const token of keywordTokens) {
    if (candidateTokens.has(token)) {
      intersection++;
      if (!firstCommon) firstCommon = token;
    }
  }
  if (intersection === 0) return null;
  return { score: 10 * intersection, matchedField: `token:${firstCommon}` };
}

function scoreConnector(
  keywordLower: string,
  keywordTokens: Set<string>,
  type: ConnectorType,
  config: ConnectorConfig,
): ScoreHit | null {
  const exact = findExactMatch(keywordLower, type, config);
  if (exact) return exact;

  const candidates: ScoreHit[] = [];
  const substring = findSubstringMatch(keywordLower, type, config);
  if (substring) candidates.push(substring);
  const token = findTokenIntersection(keywordTokens, type, config);
  if (token) candidates.push(token);

  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => {
    return a.score >= b.score ? a : b;
  });
  if (best.score < MIN_SCORE) return null;
  return best;
}

/**
 * Search the connector catalog by weighted multi-field ranking.
 *
 * Matches the keyword against type keys, labels, env var names, secret names,
 * and `tags`. Score is the max over matched rules (never a sum). Results with
 * score below the minimum threshold are dropped. Sort order: score desc, then
 * type asc.
 */
export function searchConnectors(
  keyword: string,
  limit: number,
  filter?: (type: ConnectorType) => boolean,
): ConnectorSearchOutput {
  const trimmed = keyword.trim();
  if (!trimmed) return { results: [], total: 0 };

  const keywordLower = trimmed.toLowerCase();
  const keywordTokens = tokenize(trimmed);

  const hits: ConnectorSearchResult[] = [];
  for (const type of CONNECTOR_TYPE_KEYS) {
    if (filter && !filter(type)) continue;
    const config = CONNECTOR_TYPES[type];
    const hit = scoreConnector(keywordLower, keywordTokens, type, config);
    if (!hit) continue;
    hits.push({ type, score: hit.score, matchedField: hit.matchedField });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.type.localeCompare(b.type);
  });

  const capped = limit > 0 ? hits.slice(0, limit) : hits;
  return { results: capped, total: hits.length };
}
