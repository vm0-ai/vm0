import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  connectorRegistryAuthMethodIdSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorRegistryAuthMethodId,
  type ConnectorAuthCodeGrantAuthMethodId,
  type ConnectorDeviceAuthGrantAuthMethodId,
  type ConnectorExternalCodeGrantAuthMethodId,
  type ConnectorAuthMethodIds,
  type ConnectorAuthMethodIdsByAccessKind,
  type ConnectorAuthMethodIdsByGrantKind,
  type ConnectorAuthMethodIdsByRevokeKind,
  type ConnectorTypesByAccessKind,
  type ConnectorTypesByGrantKind,
  type ConnectorAuthClientConfigForMethod,
  type ConnectorAuthMethodConfigFor,
  type RefreshTokenAccessConnectorType,
  type ConnectorAccessKind,
  type ConnectorBrowserAuthCallbackOrigin,
  type ConnectorAuthCodeCallbackOrigin,
  type ConnectorAuthCodeGrantConfig,
  type ConnectorAuthClientConfig,
  type ConnectorDeviceAuthGrantConfig,
  type ConnectorExternalCodeGrantConfig,
  type ConnectorOpenIdAuthGrantConfig,
  type ConnectorDeviceAuthStartOptions,
  type ConnectorDeviceAuthStartOptionsConfig,
  type ConnectorGenerationType,
  type ConnectorGrantKind,
  type ConnectorRevokeKind,
  type ConnectorType,
  type AuthCodeGrantConnectorType,
  type DeviceAuthGrantConnectorType,
  type ExternalCodeGrantConnectorType,
  type OpenIdAuthGrantConnectorType,
  type ConnectorOpenIdAuthGrantAuthMethodId,
} from "./connectors";
import {
  connectorAuthClientIdentity,
  connectorAuthMethodAccessMetadata,
  connectorAuthMethodEnvBindings,
  connectorAuthMethodGrantMetadata,
  connectorAuthMethodHasRequiredScopes,
  connectorAuthMethodManualGrantFieldNames,
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodOwnedVariableNames,
  connectorAuthMethodPrivateNames,
  connectorAuthMethodRevokeMetadata,
  connectorAuthMethodRuntimeMetadata,
  connectorAuthMethodScopeDiff,
  connectorAuthCodeGrantCallbackOrigin,
  connectorGrantScopes,
  connectorOpenIdAuthGrantCallbackOrigin,
  parseConnectorDeviceAuthStartOptionsConfig,
  resolveConnectorAuthClient,
  type ConnectorAuthClient,
  type ConnectorAuthClientForConfig,
  type ConnectorAuthClientIdentityForConfig,
  type ConnectorAuthMethodAccessMetadata,
  type ConnectorAuthMethodGrantMetadata,
  type ConnectorAuthMethodRevokeMetadata,
  type ConnectorAuthMethodRuntimeMetadata,
  type ConnectorDeviceAuthStartOptionsParseResult,
  type ConnectorEnvReader,
  type ConnectorFeatureStates,
  type ConnectorManualGrantFieldNames,
  type ConnectorRefreshTokenAccessMetadata,
  type ConnectorRuntimeEnvBindings,
  type ScopeDiff,
} from "./connector-auth-method";

export * from "./connector-auth-method";

const CONNECTOR_AUTH_METHOD_PRIORITY = {
  oauth: 0,
  openid: 1,
  cli: 2,
  "api-token": 3,
  api: 4,
} as const satisfies Record<ConnectorRegistryAuthMethodId, number>;

function connectorAuthMethodPriority(
  authMethod: ConnectorRegistryAuthMethodId,
): number {
  return CONNECTOR_AUTH_METHOD_PRIORITY[authMethod];
}

export function getConfiguredConnectorAuthMethodIds(
  type: ConnectorType,
): ConnectorRegistryAuthMethodId[] {
  // Configured methods are raw registry entries; callers apply availability filters.
  return Object.keys(CONNECTOR_TYPES[type].authMethods)
    .map((authMethod) => {
      return connectorRegistryAuthMethodIdSchema.parse(authMethod);
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
 *   feature-switch and surface policy filtering.
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

export function getConnectorManualGrantFieldNamesForAuthMethod(
  type: ConnectorType,
  authMethod: string,
): ConnectorManualGrantFieldNames | null {
  const method = getConnectorAuthMethod(type, authMethod);
  return method ? connectorAuthMethodManualGrantFieldNames(method) : null;
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

/**
 * Private connector implementation names that must not appear in public
 * catalog surfaces or public form ids.
 */
export function getConnectorAuthMethodPrivateNames(
  type: ConnectorType,
  authMethod: string,
): readonly string[] {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return [];
  }
  return connectorAuthMethodPrivateNames(method);
}

export function getConnectorPrivateNames(
  type: ConnectorType,
  authMethods: readonly string[] = getConfiguredConnectorAuthMethodIds(type),
): readonly string[] {
  const privateNames = new Set<string>();
  for (const authMethod of authMethods) {
    for (const privateName of getConnectorAuthMethodPrivateNames(
      type,
      authMethod,
    )) {
      privateNames.add(privateName);
    }
  }
  return [...privateNames];
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

  return connectorAuthMethodAccessMetadata(method);
}

export function getConnectorAuthMethodGrantMetadata(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodGrantMetadata | undefined {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return undefined;
  }

  return connectorAuthMethodGrantMetadata(method);
}

export function getConnectorAuthMethodRevokeMetadata(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodRevokeMetadata | undefined {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return undefined;
  }

  return connectorAuthMethodRevokeMetadata(method);
}

export function getConnectorAuthMethodRuntimeMetadata(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthMethodRuntimeMetadata | undefined {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return undefined;
  }

  return connectorAuthMethodRuntimeMetadata(method);
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
  readonly authMethod: ConnectorRegistryAuthMethodId;
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
> = ConnectorAuthMethodRef & {
  readonly __connectorAuthMethodAccessKind?: Kind;
};

export type ConnectorAuthMethodRefByRevokeKind<
  Kind extends ConnectorRevokeKind,
> = ConnectorAuthMethodRef & {
  readonly __connectorAuthMethodRevokeKind?: Kind;
};

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

export function getConnectorAuthMethodOpenIdAuthGrantConfig<
  Type extends OpenIdAuthGrantConnectorType,
>(
  type: Type,
  authMethod: ConnectorOpenIdAuthGrantAuthMethodId<Type>,
): ConnectorOpenIdAuthGrantConfig;
export function getConnectorAuthMethodOpenIdAuthGrantConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorOpenIdAuthGrantConfig | undefined;
export function getConnectorAuthMethodOpenIdAuthGrantConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorOpenIdAuthGrantConfig | undefined {
  const grant = getConnectorAuthMethod(type, authMethod)?.grant;
  return grant?.kind === "openid-auth" ? grant : undefined;
}

export function getConnectorAuthMethodOpenIdAuthCallbackOrigin<
  Type extends OpenIdAuthGrantConnectorType,
>(
  type: Type,
  authMethod: ConnectorOpenIdAuthGrantAuthMethodId<Type>,
): ConnectorBrowserAuthCallbackOrigin;
export function getConnectorAuthMethodOpenIdAuthCallbackOrigin(
  type: ConnectorType,
  authMethod: string,
): ConnectorBrowserAuthCallbackOrigin | undefined;
export function getConnectorAuthMethodOpenIdAuthCallbackOrigin(
  type: ConnectorType,
  authMethod: string,
): ConnectorBrowserAuthCallbackOrigin | undefined {
  const grant = getConnectorAuthMethodOpenIdAuthGrantConfig(type, authMethod);
  if (!grant) {
    return undefined;
  }
  return connectorOpenIdAuthGrantCallbackOrigin(grant);
}

export function getConnectorAuthMethodAuthCodeCallbackOrigin<
  Type extends AuthCodeGrantConnectorType,
>(
  type: Type,
  authMethod: ConnectorAuthCodeGrantAuthMethodId<Type>,
): ConnectorAuthCodeCallbackOrigin;
export function getConnectorAuthMethodAuthCodeCallbackOrigin(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthCodeCallbackOrigin | undefined;
export function getConnectorAuthMethodAuthCodeCallbackOrigin(
  type: ConnectorType,
  authMethod: string,
): ConnectorAuthCodeCallbackOrigin | undefined {
  const grant = getConnectorAuthMethodAuthCodeGrantConfig(type, authMethod);
  if (!grant) {
    return undefined;
  }
  return connectorAuthCodeGrantCallbackOrigin(grant);
}

export function connectorAuthCodeCallbacksUseOnlyApiOrigin(
  type: AuthCodeGrantConnectorType,
): boolean {
  const authMethods = getConnectorAuthMethodIdsForGrantKind(type, "auth-code");
  return authMethods.every((authMethod) => {
    return (
      getConnectorAuthMethodAuthCodeCallbackOrigin(type, authMethod) === "api"
    );
  });
}

export function getConnectorAuthMethodExternalCodeGrantConfig<
  Type extends ExternalCodeGrantConnectorType,
>(
  type: Type,
  authMethod: ConnectorExternalCodeGrantAuthMethodId<Type>,
): ConnectorExternalCodeGrantConfig;
export function getConnectorAuthMethodExternalCodeGrantConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorExternalCodeGrantConfig | undefined;
export function getConnectorAuthMethodExternalCodeGrantConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorExternalCodeGrantConfig | undefined {
  const grant = getConnectorAuthMethod(type, authMethod)?.grant;
  return grant?.kind === "external-code" ? grant : undefined;
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

export function getConnectorAuthMethodDeviceAuthStartOptionsConfig<
  Type extends DeviceAuthGrantConnectorType,
>(
  type: Type,
  authMethod: ConnectorDeviceAuthGrantAuthMethodId<Type>,
): ConnectorDeviceAuthStartOptionsConfig | undefined;
export function getConnectorAuthMethodDeviceAuthStartOptionsConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorDeviceAuthStartOptionsConfig | undefined;
export function getConnectorAuthMethodDeviceAuthStartOptionsConfig(
  type: ConnectorType,
  authMethod: string,
): ConnectorDeviceAuthStartOptionsConfig | undefined {
  return getConnectorAuthMethodDeviceAuthGrantConfig(type, authMethod)
    ?.startOptions;
}

export function parseConnectorDeviceAuthStartOptions(args: {
  readonly type: ConnectorType;
  readonly authMethod: string;
  readonly options: ConnectorDeviceAuthStartOptions | undefined;
}): ConnectorDeviceAuthStartOptionsParseResult {
  return parseConnectorDeviceAuthStartOptionsConfig({
    connectorRef: args.type,
    authMethodId: args.authMethod,
    startOptions: getConnectorAuthMethodDeviceAuthStartOptionsConfig(
      args.type,
      args.authMethod,
    ),
    options: args.options,
  });
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

export type ApiAuthMethodPolicy =
  | "exclude"
  | "include"
  | { readonly includeForTypes: readonly ConnectorType[] };

export interface AvailableConnectorAuthMethodsOptions {
  readonly apiAuthMethodPolicy?: ApiAuthMethodPolicy;
}

/**
 * Returns whether an auth method belongs in user-specific discovery output.
 * Feature switches are UI rollout state, not execution authorization. Runtime
 * callers must resolve the method contract without consulting this function.
 */
export function isConnectorAuthMethodAvailable(
  type: ConnectorType,
  authMethod: ConnectorRegistryAuthMethodId,
  featureStates: ConnectorFeatureStates,
): boolean {
  const method = getConnectorAuthMethod(type, authMethod);
  if (!method) {
    return false;
  }
  if (method.visible === false) {
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
 * This includes static visibility, feature-switch, and surface policy filtering.
 * It does not describe persisted connected state.
 */
export function getAvailableConnectorAuthMethodIds(
  type: ConnectorType,
  featureStates: ConnectorFeatureStates,
  options: AvailableConnectorAuthMethodsOptions = {},
): ConnectorRegistryAuthMethodId[] {
  const apiAuthMethodPolicy = options.apiAuthMethodPolicy ?? "exclude";
  const availableAuthMethodIds: ConnectorRegistryAuthMethodId[] = [];
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
      case "openid-auth":
      case "auth-code":
      case "external-code":
      case "device-auth":
      case "none":
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

export type ConnectorAuthClientForMethod<
  Type extends ConnectorType,
  Method extends ConnectorAuthMethodIds<Type>,
> = ConnectorAuthClientForConfig<
  ConnectorAuthClientConfigForMethod<Type, Method>
>;

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

export type ConnectorGrantKindWithAuthClient =
  | "auth-code"
  | "external-code"
  | "device-auth";

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
  readonly authMethod: ConnectorRegistryAuthMethodId;
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
  authMethodRef: ConnectorAuthMethodRefByGrantKind<"external-code">,
  readEnv: ConnectorEnvReader,
): ConnectorResolvedAuthMethodClientByGrantKind<"external-code"> | undefined;
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
      case "external-code":
      case "device-auth": {
        if (resolveConnectorAuthClientForMethod(type, authMethod, readEnv)) {
          return true;
        }
        break;
      }
      case "openid-auth": {
        return true;
      }
      case "manual": {
        return true;
      }
      case "none": {
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

/**
 * Get runtime environment bindings for a specific connector auth method.
 */
export function getConnectorAuthMethodEnvBindings(
  type: ConnectorType,
  authMethod: string,
): ConnectorRuntimeEnvBindings {
  const method = getConnectorAuthMethod(type, authMethod);
  return method ? connectorAuthMethodEnvBindings(method) : {};
}

export interface ConnectorEnvBindingEntry {
  readonly authMethod: ConnectorRegistryAuthMethodId;
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

export function hasConnectorOpenIdAuthGrant(
  type: ConnectorType,
): type is OpenIdAuthGrantConnectorType {
  return getConnectorAuthMethodIdsForGrantKind(type, "openid-auth").length > 0;
}

export function hasConnectorExternalCodeGrant(
  type: ConnectorType,
): type is ExternalCodeGrantConnectorType {
  return (
    getConnectorAuthMethodIdsForGrantKind(type, "external-code").length > 0
  );
}

export function hasConnectorDeviceAuthGrant(
  type: ConnectorType,
): type is DeviceAuthGrantConnectorType {
  return getConnectorAuthMethodIdsForGrantKind(type, "device-auth").length > 0;
}

export function hasRequiredConnectorAuthMethodScopes(
  connectorType: ConnectorType,
  authMethod: string,
  storedScopes: string[] | null,
): boolean {
  const method = getConnectorAuthMethod(connectorType, authMethod);
  return method
    ? connectorAuthMethodHasRequiredScopes(method, storedScopes)
    : true;
}

export function getConnectorAuthMethodScopeDiff(
  connectorType: ConnectorType,
  authMethod: string,
  storedScopes: string[] | null,
): ScopeDiff {
  const method = getConnectorAuthMethod(connectorType, authMethod);
  if (method) {
    return connectorAuthMethodScopeDiff(method, storedScopes);
  }
  return {
    addedScopes: [],
    removedScopes: storedScopes ?? [],
    currentScopes: [],
    storedScopes: storedScopes ?? [],
  };
}
