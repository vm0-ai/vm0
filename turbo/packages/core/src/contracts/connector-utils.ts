import {
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodType,
  type ConnectorOAuthConfig,
  type ConnectorSecretConfig,
  type ConnectorType,
} from "./connectors";

/**
 * Get auth methods for a connector type
 */
export function getConnectorAuthMethods(
  type: ConnectorType,
): Partial<Record<ConnectorAuthMethodType, ConnectorAuthMethodConfig>> {
  return CONNECTOR_TYPES[type].authMethods;
}

/**
 * Get default auth method for a connector type
 */
export function getConnectorDefaultAuthMethod(
  type: ConnectorType,
): ConnectorAuthMethodType | undefined {
  return CONNECTOR_TYPES[type].defaultAuthMethod;
}

/**
 * Get secrets config for a specific auth method
 */
export function getConnectorSecretsForAuthMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodType,
): Record<string, ConnectorSecretConfig> | undefined {
  const authMethods = getConnectorAuthMethods(type);
  return authMethods[authMethod]?.secrets;
}

/**
 * Get secret names for a specific auth method
 */
export function getConnectorSecretNames(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodType,
): string[] {
  const secrets = getConnectorSecretsForAuthMethod(type, authMethod);
  return secrets ? Object.keys(secrets) : [];
}

/**
 * Get environment mapping for a connector type.
 */
export function getConnectorEnvironmentMapping(
  type: ConnectorType,
): Record<string, string> {
  return CONNECTOR_TYPES[type].environmentMapping;
}

/**
 * Connector types eligible for agent compose: GA (no feature flag) or
 * feature-flagged with an api-token auth method.  Feature flags only gate
 * OAuth; api-token is always available.
 */
export function getEligibleConnectorTypes(): string[] {
  return Object.entries(CONNECTOR_TYPES)
    .filter(([, config]) => {
      return !config.featureFlag || "api-token" in config.authMethods;
    })
    .map(([type]) => {
      return type;
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
  const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

  for (const type of allTypes) {
    const config = CONNECTOR_TYPES[type];

    // Check if this secret belongs to any auth method of this connector
    const authMethods = config.authMethods as Record<
      string,
      ConnectorAuthMethodConfig
    >;
    let found = false;
    for (const method of Object.values(authMethods)) {
      if (method.secrets && secretName in method.secrets) {
        found = true;
        break;
      }
    }

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

/**
 * Get OAuth configuration for a connector type
 */
export function getConnectorOAuthConfig(
  type: ConnectorType,
): ConnectorOAuthConfig | undefined {
  const config = CONNECTOR_TYPES[type];
  return "oauth" in config ? config.oauth : undefined;
}

/**
 * Check if a connector type uses Google OAuth (accounts.google.com).
 */
export function isGoogleOAuthConnector(type: ConnectorType): boolean {
  const oauthConfig = getConnectorOAuthConfig(type);
  if (!oauthConfig?.authorizationUrl) return false;
  try {
    return (
      new URL(oauthConfig.authorizationUrl).hostname === "accounts.google.com"
    );
  } catch {
    return false;
  }
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
  const oauthConfig = getConnectorOAuthConfig(connectorType);
  if (!oauthConfig) return true;
  if (oauthConfig.scopes.length === 0) return true;
  if (!storedScopes) return false;
  const storedSet = new Set(storedScopes);
  return oauthConfig.scopes.every((s) => {
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
  const oauthConfig = getConnectorOAuthConfig(connectorType);
  const currentScopes = oauthConfig?.scopes ?? [];
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
      for (const name of Object.keys(method.secrets)) {
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
 * Checks both authMethods.secrets keys and environmentMapping keys.
 * Returns null if no connector manages this name.
 */
export function getConnectorTypeForSecretName(
  name: string,
): ConnectorType | null {
  const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];
  for (const type of allTypes) {
    const config = CONNECTOR_TYPES[type];
    // Check authMethods secrets
    for (const method of Object.values(config.authMethods)) {
      if (name in method.secrets) {
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

/**
 * Get required secret names for a connector's api-token auth method.
 * Returns null if the connector type does not support api-token auth.
 * Note: Returns ALL required field names regardless of storage type (secret or variable).
 */
export function getApiTokenRequiredSecretNames(
  type: ConnectorType,
): string[] | null {
  const config = CONNECTOR_TYPES[type];
  const apiTokenConfig = config.authMethods["api-token"] as
    | ConnectorAuthMethodConfig
    | undefined;
  if (!apiTokenConfig) return null;

  return Object.entries(apiTokenConfig.secrets)
    .filter(([, cfg]) => {
      return cfg.required;
    })
    .map(([name]) => {
      return name;
    });
}

/**
 * Get required field names grouped by storage type for a connector's api-token auth method.
 * Returns null if the connector type does not support api-token auth.
 */
export function getApiTokenFieldsByType(
  type: ConnectorType,
): { secrets: string[]; variables: string[] } | null {
  const config = CONNECTOR_TYPES[type];
  const apiTokenConfig = config.authMethods["api-token"] as
    | ConnectorAuthMethodConfig
    | undefined;
  if (!apiTokenConfig) return null;

  const secretNames: string[] = [];
  const variableNames: string[] = [];
  for (const [name, cfg] of Object.entries(apiTokenConfig.secrets)) {
    if (!cfg.required) continue;
    if (cfg.type === "variable") {
      variableNames.push(name);
    } else {
      secretNames.push(name);
    }
  }
  return { secrets: secretNames, variables: variableNames };
}

/**
 * Derive which connector types are "connected" via api-token based on present user secret and variable names.
 * A connector type is considered connected if all its required api-token fields exist
 * (secrets checked against userSecretNames, variables checked against userVariableNames).
 */
export function deriveApiTokenConnectedTypes(
  userSecretNames: Set<string>,
  userVariableNames?: Set<string>,
): ConnectorType[] {
  const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];
  const connected: ConnectorType[] = [];
  const varNames = userVariableNames ?? new Set<string>();

  for (const type of allTypes) {
    const fields = getApiTokenFieldsByType(type);
    if (!fields) continue;
    if (fields.secrets.length === 0 && fields.variables.length === 0) continue;
    const secretsOk = fields.secrets.every((name) => {
      return userSecretNames.has(name);
    });
    const variablesOk = fields.variables.every((name) => {
      return varNames.has(name);
    });
    if (secretsOk && variablesOk) {
      connected.push(type);
    }
  }

  return connected;
}
