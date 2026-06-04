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
  type ConnectorTypesByAccessKind,
  type ConnectorTypesByGrantKind,
  type ConnectorTypesByRevokeKind,
  type ConnectorAuthClientConfigForMethod,
  type ConnectorAuthMethodConfigFor,
  type RefreshTokenAccessConnectorType,
  type ConnectorAccessConfig,
  type ConnectorAccessKind,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorAuthClientConfig,
  type ConnectorDeviceAuthGrantConfig,
  type ConnectorEnvBindings,
  type ConnectorGenerationType,
  type ConnectorGrantOutputBindings,
  type ConnectorGrantConfig,
  type ConnectorGrantKind,
  type ConnectorManualGrantFieldConfig,
  type ConnectorPlatformSecretName,
  type ConnectorRefreshTokenInputValueRef,
  type ConnectorRefreshTokenInputBindings,
  type ConnectorRefreshTokenOutputBindings,
  type ConnectorRevokeInputBindings,
  type ConnectorRevokeKind,
  type ConnectorSecretValueRef,
  type ConnectorVariableValueRef,
  type ConnectorType,
  type AuthCodeGrantConnectorType,
  type DeviceAuthGrantConnectorType,
  type DynamicPublicConnectorAuthClientConfig,
  type StaticConfidentialConnectorAuthClientConfig,
  type StaticPublicConnectorAuthClientConfig,
} from "./connectors";
import type { FeatureSwitchKey } from "./feature-switch-key";

const CONNECTOR_AUTH_METHOD_PRIORITY = {
  oauth: 0,
  "api-token": 1,
  api: 2,
} as const satisfies Record<ConnectorAuthMethodId, number>;
const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";
const CONNECTOR_VARIABLE_REF_PREFIX = "$vars.";

function connectorAuthMethodPriority(
  authMethod: ConnectorAuthMethodId,
): number {
  return CONNECTOR_AUTH_METHOD_PRIORITY[authMethod];
}

export function getConfiguredConnectorAuthMethodIds(
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
export function getConnectorAuthMethod<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
>(type: Type, authMethod: Method): ConnectorAuthMethodConfigFor<Type, Method>;
export function getConnectorAuthMethod(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodConfig | undefined;
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
  return getConfiguredConnectorAuthMethodIds(type).filter(
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
  return getConfiguredConnectorAuthMethodIds(type).filter(
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
  return getConfiguredConnectorAuthMethodIds(type).filter(
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

export interface ConnectorManualGrantFieldNames {
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
}

function manualGrantFieldNames(
  fields: Record<string, ConnectorManualGrantFieldConfig>,
): ConnectorManualGrantFieldNames {
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

export function getConnectorManualGrantFieldNamesForAuthMethod(
  type: ConnectorType,
  authMethod: string,
): ConnectorManualGrantFieldNames | null {
  const fields = getManualGrantFields(getConnectorAuthMethod(type, authMethod));
  return fields ? manualGrantFieldNames(fields) : null;
}

export function getConnectorManualGrantFieldNames(
  type: ConnectorType,
): ConnectorManualGrantFieldNames | null {
  const secretNames = new Set<string>();
  const variableNames = new Set<string>();
  for (const authMethod of getConfiguredConnectorAuthMethodIds(type)) {
    const fields = getConnectorManualGrantFieldNamesForAuthMethod(
      type,
      authMethod,
    );
    if (!fields) {
      continue;
    }
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

function connectorAccessPlatformSecrets(
  access: ConnectorAccessConfig,
): readonly ConnectorPlatformSecretName[] {
  switch (access.kind) {
    case "static":
    case "refresh-token":
      return access.platformSecrets ?? [];
    case "none":
      return [];
  }
}

export type ConnectorAuthMethodAccessMetadata =
  | {
      readonly kind: "static";
      readonly envBindings: ConnectorEnvBindings;
      readonly platformSecrets: readonly ConnectorPlatformSecretName[];
    }
  | {
      readonly kind: "refresh-token";
      readonly inputs: Readonly<
        Record<string, ConnectorRefreshTokenInputMetadata>
      >;
      readonly outputs: Readonly<
        Record<string, ConnectorRefreshTokenOutputMetadata>
      >;
      readonly refreshableSecrets: readonly string[];
      readonly envBindings: ConnectorEnvBindings;
      readonly platformSecrets: readonly ConnectorPlatformSecretName[];
    }
  | {
      readonly kind: "none";
      readonly envBindings: ConnectorEnvBindings;
      readonly platformSecrets: readonly ConnectorPlatformSecretName[];
    };

export type ConnectorRefreshTokenAccessMetadata = Extract<
  ConnectorAuthMethodAccessMetadata,
  { readonly kind: "refresh-token" }
>;

export interface ConnectorRefreshTokenInputMetadata {
  readonly valueRef: string;
  readonly source: Extract<
    ConnectorRuntimeBindingSource,
    { readonly kind: "connector-secret" | "connector-variable" }
  >;
}

export interface ConnectorRefreshTokenOutputMetadata {
  readonly valueRef: string;
  readonly secretName: string;
}

export interface ConnectorRefreshTokenMetadata {
  readonly inputs: Readonly<Record<string, ConnectorRefreshTokenInputMetadata>>;
  readonly outputs: Readonly<
    Record<string, ConnectorRefreshTokenOutputMetadata>
  >;
  readonly refreshableSecrets: readonly string[];
}

export interface ConnectorGrantOutputMetadata {
  readonly valueRef: string;
  readonly secretName: string;
}

export type ConnectorAuthMethodGrantMetadata =
  | {
      readonly kind: "auth-code" | "device-auth";
      readonly outputs: Readonly<Record<string, ConnectorGrantOutputMetadata>>;
    }
  | {
      readonly kind: "manual" | "managed";
      readonly outputs: Readonly<Record<string, ConnectorGrantOutputMetadata>>;
    };

export interface ConnectorRevokeInputMetadata {
  readonly valueRef: string;
  readonly secretName: string;
}

export type ConnectorAuthMethodRevokeMetadata =
  | {
      readonly kind: "token-revoke";
      readonly inputs: Readonly<Record<string, ConnectorRevokeInputMetadata>>;
    }
  | {
      readonly kind: "none";
      readonly inputs: Readonly<Record<string, ConnectorRevokeInputMetadata>>;
    };

export type ConnectorRuntimeBindingSource =
  | {
      readonly kind: "connector-secret";
      readonly name: string;
    }
  | {
      readonly kind: "connector-variable";
      readonly name: string;
    }
  | {
      readonly kind: "platform-secret";
      readonly name: ConnectorPlatformSecretName;
    };

export interface ConnectorRuntimeBindingEntry {
  readonly envName: string;
  readonly valueRef: string;
  readonly source: ConnectorRuntimeBindingSource;
}

export interface ConnectorAuthMethodRuntimeMetadata {
  readonly storage: {
    readonly secrets: readonly string[];
    readonly variables: readonly string[];
  };
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
}

function isConnectorSecretValueRef(
  valueRef: ConnectorRefreshTokenInputValueRef,
): valueRef is ConnectorSecretValueRef {
  return valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX);
}

function connectorSecretNameFromValueRef(
  valueRef: ConnectorSecretValueRef,
): string {
  return valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length);
}

function connectorVariableNameFromValueRef(
  valueRef: ConnectorVariableValueRef,
): string {
  return valueRef.slice(CONNECTOR_VARIABLE_REF_PREFIX.length);
}

function connectorRefreshInputMetadata(
  valueRef: ConnectorRefreshTokenInputValueRef,
): ConnectorRefreshTokenInputMetadata {
  if (isConnectorSecretValueRef(valueRef)) {
    return {
      valueRef,
      source: {
        kind: "connector-secret",
        name: connectorSecretNameFromValueRef(valueRef),
      },
    };
  }

  const variableName = connectorVariableNameFromValueRef(valueRef);
  return {
    valueRef,
    source: { kind: "connector-variable", name: variableName },
  };
}

function connectorRefreshOutputMetadata(
  valueRef: ConnectorSecretValueRef,
): ConnectorRefreshTokenOutputMetadata {
  return { valueRef, secretName: connectorSecretNameFromValueRef(valueRef) };
}

function connectorGrantOutputMetadata(
  valueRef: ConnectorSecretValueRef,
): ConnectorGrantOutputMetadata {
  return connectorRefreshOutputMetadata(valueRef);
}

function connectorRevokeInputMetadata(
  valueRef: ConnectorSecretValueRef,
): ConnectorRevokeInputMetadata {
  return { valueRef, secretName: connectorSecretNameFromValueRef(valueRef) };
}

function connectorRefreshMetadata(args: {
  readonly inputs: ConnectorRefreshTokenInputBindings;
  readonly outputs: ConnectorRefreshTokenOutputBindings;
  readonly refreshableSecrets: readonly string[];
}): ConnectorRefreshTokenMetadata {
  return {
    inputs: Object.fromEntries(
      Object.entries(args.inputs).map(([name, valueRef]) => {
        return [name, connectorRefreshInputMetadata(valueRef)];
      }),
    ),
    outputs: Object.fromEntries(
      Object.entries(args.outputs).map(([name, valueRef]) => {
        return [name, connectorRefreshOutputMetadata(valueRef)];
      }),
    ),
    refreshableSecrets: [...args.refreshableSecrets],
  };
}

export function getConnectorAuthMethodAccessMetadata<
  Type extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<Type, "refresh-token">,
>(type: Type, authMethod: Method): ConnectorRefreshTokenAccessMetadata;
export function getConnectorAuthMethodAccessMetadata(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodAccessMetadata | undefined;
export function getConnectorAuthMethodAccessMetadata(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodAccessMetadata | undefined {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return undefined;
  }

  switch (method.access.kind) {
    case "static": {
      return {
        kind: "static",
        envBindings: method.access.envBindings,
        platformSecrets: method.access.platformSecrets ?? [],
      };
    }
    case "refresh-token":
      return {
        kind: "refresh-token",
        ...connectorRefreshMetadata(method.access),
        envBindings: method.access.envBindings,
        platformSecrets: method.access.platformSecrets ?? [],
      };
    case "none":
      return {
        kind: "none",
        envBindings: {},
        platformSecrets: [],
      };
  }
}

function connectorGrantOutputMetadataMap(
  outputs: ConnectorGrantOutputBindings,
): Record<string, ConnectorGrantOutputMetadata> {
  return Object.fromEntries(
    Object.entries(outputs).map(([name, valueRef]) => {
      return [name, connectorGrantOutputMetadata(valueRef)];
    }),
  );
}

export function getConnectorAuthMethodGrantMetadata(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodGrantMetadata | undefined {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return undefined;
  }

  switch (method.grant.kind) {
    case "auth-code":
    case "device-auth":
      return {
        kind: method.grant.kind,
        outputs: connectorGrantOutputMetadataMap(method.grant.outputs),
      };
    case "manual":
    case "managed":
      return {
        kind: method.grant.kind,
        outputs: {},
      };
  }
}

export function getConnectorGrantOutputSecretName(
  metadata: ConnectorAuthMethodGrantMetadata,
  outputName: string,
): string | undefined {
  return metadata.outputs[outputName]?.secretName;
}

function connectorRevokeInputMetadataMap(
  inputs: ConnectorRevokeInputBindings,
): Record<string, ConnectorRevokeInputMetadata> {
  return Object.fromEntries(
    Object.entries(inputs).map(([name, valueRef]) => {
      return [name, connectorRevokeInputMetadata(valueRef)];
    }),
  );
}

export function getConnectorAuthMethodRevokeMetadata(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodRevokeMetadata | undefined {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return undefined;
  }

  switch (method.revoke.kind) {
    case "token-revoke":
      return {
        kind: "token-revoke",
        inputs: connectorRevokeInputMetadataMap(method.revoke.inputs),
      };
    case "none":
      return {
        kind: "none",
        inputs: {},
      };
  }
}

export function getConnectorRefreshOutputSecretName(
  metadata: ConnectorAuthMethodAccessMetadata,
  outputName: string,
): string | undefined {
  return metadata.kind === "refresh-token"
    ? metadata.outputs[outputName]?.secretName
    : undefined;
}

export function getConnectorRuntimeBindingSecretName(
  metadata: ConnectorAuthMethodRuntimeMetadata,
  envName: string,
): string | undefined {
  const binding = metadata.runtimeBindings.find((entry) => {
    return (
      entry.envName === envName && entry.source.kind === "connector-secret"
    );
  });
  return binding?.source.kind === "connector-secret"
    ? binding.source.name
    : undefined;
}

export function connectorRefreshMetadataHasRefreshableSecret(
  metadata: ConnectorAuthMethodAccessMetadata,
  secretName: string,
): boolean {
  return (
    metadata.kind === "refresh-token" &&
    metadata.refreshableSecrets.includes(secretName)
  );
}

function connectorPlatformSecretSource(
  secretName: string,
  platformSecrets: readonly ConnectorPlatformSecretName[],
): ConnectorPlatformSecretName | undefined {
  return platformSecrets.find((platformSecret) => {
    return platformSecret === secretName;
  });
}

function connectorRuntimeBindingEntries(args: {
  readonly envBindings: ConnectorEnvBindings;
  readonly platformSecrets: readonly ConnectorPlatformSecretName[];
}): ConnectorRuntimeBindingEntry[] {
  const entries: ConnectorRuntimeBindingEntry[] = [];
  for (const [envName, valueRef] of Object.entries(args.envBindings)) {
    if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
      const secretName = valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length);
      const platformSecret = connectorPlatformSecretSource(
        secretName,
        args.platformSecrets,
      );
      entries.push({
        envName,
        valueRef,
        source: platformSecret
          ? { kind: "platform-secret", name: platformSecret }
          : { kind: "connector-secret", name: secretName },
      });
      continue;
    }

    if (valueRef.startsWith(CONNECTOR_VARIABLE_REF_PREFIX)) {
      entries.push({
        envName,
        valueRef,
        source: {
          kind: "connector-variable",
          name: valueRef.slice(CONNECTOR_VARIABLE_REF_PREFIX.length),
        },
      });
    }
  }
  return entries;
}

export function getConnectorAuthMethodRuntimeMetadata(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodRuntimeMetadata | undefined {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return undefined;
  }
  const platformSecrets = connectorAccessPlatformSecrets(method.access);
  return {
    storage: {
      secrets: [...method.storage.secrets],
      variables: [...method.storage.variables],
    },
    runtimeBindings: connectorRuntimeBindingEntries({
      envBindings: connectorAccessEnvBindings(method.access),
      platformSecrets,
    }),
  };
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

export type ConnectorAuthMethodRefByAccessKind<
  Kind extends ConnectorAccessKind,
> = {
  readonly [Type in ConnectorTypesByAccessKind<Kind>]: {
    readonly type: Type;
    readonly authMethod: ConnectorAuthMethodIdsByAccessKind<Type, Kind>;
  };
}[ConnectorTypesByAccessKind<Kind>];

export type ConnectorAuthMethodRefByRevokeKind<
  Kind extends ConnectorRevokeKind,
> = {
  readonly [Type in ConnectorTypesByRevokeKind<Kind>]: {
    readonly type: Type;
    readonly authMethod: ConnectorAuthMethodIdsByRevokeKind<Type, Kind>;
  };
}[ConnectorTypesByRevokeKind<Kind>];

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

export function connectorAuthMethodRefHasAccessKind<
  Kind extends ConnectorAccessKind,
>(
  authMethodRef: ConnectorAuthMethodRef,
  accessKind: Kind,
): authMethodRef is ConnectorAuthMethodRefByAccessKind<Kind> {
  return (
    getConnectorAuthMethod(authMethodRef.type, authMethodRef.authMethod)?.access
      .kind === accessKind
  );
}

export function connectorAuthMethodRefHasRevokeKind<
  Kind extends ConnectorRevokeKind,
>(
  authMethodRef: ConnectorAuthMethodRef,
  revokeKind: Kind,
): authMethodRef is ConnectorAuthMethodRefByRevokeKind<Kind> {
  return (
    getConnectorAuthMethod(authMethodRef.type, authMethodRef.authMethod)?.revoke
      .kind === revokeKind
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
export function getAvailableConnectorAuthMethodIds(
  type: ConnectorType,
  featureStates: ConnectorFeatureStates,
  options: AvailableConnectorAuthMethodsOptions = {},
): ConnectorAuthMethodId[] {
  const apiAuthMethodPolicy = options.apiAuthMethodPolicy ?? "exclude";
  const availableAuthMethodIds: ConnectorAuthMethodId[] = [];
  const configuredAuthMethodIds = getConfiguredConnectorAuthMethodIds(type);

  for (const authMethod of configuredAuthMethodIds) {
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
      availableAuthMethodIds.push(authMethod);
    }
  }

  return availableAuthMethodIds;
}

export type ConnectorEnvReader = (name: string) => string | undefined;

export type StaticConfidentialConnectorAuthClient = {
  readonly clientRegistration: "static";
  readonly clientType: "confidential";
  readonly clientId: string;
  readonly clientSecret: string;
};

export type StaticConfidentialConnectorAuthClientIdentity = {
  readonly clientRegistration: "static";
  readonly clientType: "confidential";
  readonly clientId: string;
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

export type ConnectorAuthClientIdentity =
  | StaticConfidentialConnectorAuthClientIdentity
  | StaticPublicConnectorAuthClient
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
> = ConnectorAuthClientForConfig<
  ConnectorAuthClientConfigForMethod<Type, Method>
>;

export type ConnectorAuthClientIdentityForConfig<
  Client extends ConnectorAuthClientConfig,
> = Client extends StaticConfidentialConnectorAuthClientConfig
  ? StaticConfidentialConnectorAuthClientIdentity
  : Client extends StaticPublicConnectorAuthClientConfig
    ? StaticPublicConnectorAuthClient
    : Client extends DynamicPublicConnectorAuthClientConfig
      ? DynamicPublicConnectorAuthClient
      : never;

export type ConnectorAuthClientIdentityForMethod<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
> = ConnectorAuthClientIdentityForConfig<
  ConnectorAuthClientConfigForMethod<Type, Method>
>;

export type ConnectorResolvedAuthMethodClient<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
> = {
  readonly type: Type;
  readonly authMethod: Method;
  readonly authClient: ConnectorAuthClientForMethod<Type, Method>;
};

export type ConnectorGrantKindWithAuthClient = "auth-code" | "device-auth";

export type ConnectorResolvedAuthMethodClientByGrantKind<
  Kind extends ConnectorGrantKindWithAuthClient,
> = {
  readonly [Type in ConnectorTypesByGrantKind<Kind>]: {
    readonly [Method in ConnectorAuthMethodIdsByGrantKind<
      Type,
      Kind
    >]: ConnectorResolvedAuthMethodClient<Type, Method>;
  }[ConnectorAuthMethodIdsByGrantKind<Type, Kind>];
}[ConnectorTypesByGrantKind<Kind>];

export type ConnectorResolvedAuthMethodClientByAccessKind<
  Kind extends "refresh-token",
> = {
  readonly [Type in ConnectorTypesByAccessKind<Kind>]: {
    readonly [Method in ConnectorAuthMethodIdsByAccessKind<
      Type,
      Kind
    >]: ConnectorResolvedAuthMethodClient<Type, Method>;
  }[ConnectorAuthMethodIdsByAccessKind<Type, Kind>];
}[ConnectorTypesByAccessKind<Kind>];

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

export function connectorAuthClientIdentity(
  authClient: StaticConfidentialConnectorAuthClient,
): StaticConfidentialConnectorAuthClientIdentity;
export function connectorAuthClientIdentity(
  authClient: StaticPublicConnectorAuthClient,
): StaticPublicConnectorAuthClient;
export function connectorAuthClientIdentity(
  authClient: DynamicPublicConnectorAuthClient,
): DynamicPublicConnectorAuthClient;
export function connectorAuthClientIdentity(
  authClient: ConnectorAuthClient,
): ConnectorAuthClientIdentity;
export function connectorAuthClientIdentity(
  authClient: ConnectorAuthClient,
): ConnectorAuthClientIdentity {
  switch (authClient.clientRegistration) {
    case "dynamic":
      return authClient;
    case "static":
      return {
        clientRegistration: "static",
        clientType: authClient.clientType,
        clientId: authClient.clientId,
      };
  }
}

export function connectorAuthClientIdentityForMethod<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
>(
  authClient: ConnectorAuthClientForMethod<Type, Method>,
): ConnectorAuthClientIdentityForMethod<Type, Method> {
  return connectorAuthClientIdentity(
    authClient,
  ) as ConnectorAuthClientIdentityForMethod<Type, Method>;
}

export function getConnectorAuthClientConfigForMethod<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
>(
  type: Type,
  authMethod: Method,
): ConnectorAuthClientConfigForMethod<Type, Method> | undefined;
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

type AnyConnectorResolvedAuthMethodClient = {
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly authClient: ConnectorAuthClient;
};

function resolveConnectorResolvedAuthMethodClient(
  authMethodRef: ConnectorAuthMethodRef,
  readEnv: ConnectorEnvReader,
): AnyConnectorResolvedAuthMethodClient | undefined {
  const authClient = resolveConnectorAuthClientForMethod(
    authMethodRef.type,
    authMethodRef.authMethod,
    readEnv,
  );
  if (!authClient) {
    return undefined;
  }
  return {
    type: authMethodRef.type,
    authMethod: authMethodRef.authMethod,
    authClient,
  };
}

export function resolveConnectorResolvedAuthMethodClientByGrantKind(
  authMethodRef: ConnectorAuthMethodRefByGrantKind<"auth-code">,
  readEnv: ConnectorEnvReader,
): ConnectorResolvedAuthMethodClientByGrantKind<"auth-code"> | undefined;
export function resolveConnectorResolvedAuthMethodClientByGrantKind(
  authMethodRef: ConnectorAuthMethodRefByGrantKind<"device-auth">,
  readEnv: ConnectorEnvReader,
): ConnectorResolvedAuthMethodClientByGrantKind<"device-auth"> | undefined;
export function resolveConnectorResolvedAuthMethodClientByGrantKind(
  authMethodRef: ConnectorAuthMethodRefByGrantKind<ConnectorGrantKindWithAuthClient>,
  readEnv: ConnectorEnvReader,
): AnyConnectorResolvedAuthMethodClient | undefined {
  return resolveConnectorResolvedAuthMethodClient(authMethodRef, readEnv);
}

export function resolveConnectorResolvedAuthMethodClientByAccessKind(
  authMethodRef: ConnectorAuthMethodRefByAccessKind<"refresh-token">,
  readEnv: ConnectorEnvReader,
): ConnectorResolvedAuthMethodClientByAccessKind<"refresh-token"> | undefined;
export function resolveConnectorResolvedAuthMethodClientByAccessKind(
  authMethodRef: ConnectorAuthMethodRefByAccessKind<"refresh-token">,
  readEnv: ConnectorEnvReader,
): AnyConnectorResolvedAuthMethodClient | undefined {
  return resolveConnectorResolvedAuthMethodClient(authMethodRef, readEnv);
}

function hasRuntimeAvailableAuthMethod(
  readEnv: ConnectorEnvReader,
  type: ConnectorType,
): boolean {
  for (const authMethod of getConfiguredConnectorAuthMethodIds(type)) {
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
 * Get connector-owned secret storage names for a specific auth method.
 */
export function getConnectorOwnedSecretNames(
  type: ConnectorType,
  authMethod: string,
): string[] {
  return connectorAuthMethodOwnedSecretNames(
    getConnectorAuthMethod(type, authMethod),
  );
}

/**
 * Get connector-owned variable storage names for a specific auth method.
 */
export function getConnectorOwnedVariableNames(
  type: ConnectorType,
  authMethod: string,
): string[] {
  return connectorAuthMethodOwnedVariableNames(
    getConnectorAuthMethod(type, authMethod),
  );
}

function connectorAuthMethodOwnedSecretNames(
  method: ConnectorAuthMethodConfig | undefined,
): string[] {
  return method ? [...method.storage.secrets] : [];
}

function connectorAuthMethodOwnedVariableNames(
  method: ConnectorAuthMethodConfig | undefined,
): string[] {
  return method ? [...method.storage.variables] : [];
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
  for (const authMethod of getConfiguredConnectorAuthMethodIds(type)) {
    const envBindings = getConnectorAuthMethodEnvBindings(type, authMethod);
    for (const [envName, valueRef] of Object.entries(envBindings)) {
      entries.push({ authMethod, envName, valueRef });
    }
  }
  return entries;
}

export interface ConnectorStoredSecretDisplayInfo {
  readonly connectorLabel: string;
  readonly envNames: string[];
}

/**
 * Diagnostic/display lookup for a stored connector secret name.
 *
 * This reverse-searches registry metadata to explain which runtime env aliases
 * can expose a stored secret. Runtime injection must use selected auth method
 * storage metadata instead.
 */
export function getConnectorStoredSecretDisplayInfo(
  secretName: string,
): ConnectorStoredSecretDisplayInfo | null {
  const allTypes = CONNECTOR_TYPE_KEYS;

  for (const type of allTypes) {
    const config = CONNECTOR_TYPES[type];

    const found = Object.values(config.authMethods).some((method) => {
      return connectorAuthMethodOwnedSecretNames(method).includes(secretName);
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

/**
 * Diagnostic lookup for a runtime env alias declared by connector env bindings.
 *
 * This is for human-facing commands such as CLI doctor; runtime connector
 * behavior must use selected auth method metadata.
 */
export function getDiagnosticConnectorTypeForRuntimeEnvName(
  envName: string,
): ConnectorType | null {
  for (const type of CONNECTOR_TYPE_KEYS) {
    const hasEnvName = getConnectorEnvBindingEntries(type).some((entry) => {
      return entry.envName === envName;
    });
    if (hasEnvName) {
      return type;
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
