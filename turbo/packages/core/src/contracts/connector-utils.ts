import {
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodType,
  type ConnectorConfig,
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

function scoreConnector(
  keywordLower: string,
  keywordTokens: Set<string>,
  type: ConnectorType,
  config: ConnectorConfig,
): { score: number; matchedField: string } | null {
  // 100 — type key exact (case-insensitive)
  if (type.toLowerCase() === keywordLower) {
    return { score: 100, matchedField: "type" };
  }

  // 90 — env var key exact (any key in environmentMapping)
  for (const envVar of Object.keys(config.environmentMapping)) {
    if (envVar.toLowerCase() === keywordLower) {
      return { score: 90, matchedField: `env:${envVar}` };
    }
  }

  // 80 — label exact (case-insensitive)
  if (config.label.toLowerCase() === keywordLower) {
    return { score: 80, matchedField: "label" };
  }

  let bestScore = 0;
  let bestField = "";
  const record = (score: number, field: string): void => {
    if (score > bestScore) {
      bestScore = score;
      bestField = field;
    }
  };

  // 70 — tag exact
  if (config.tags) {
    for (const tag of config.tags) {
      if (tag === keywordLower) {
        record(70, `tag:${tag}`);
      }
    }
  }

  // 50 — type/label substring
  if (type.toLowerCase().includes(keywordLower)) {
    record(50, "type");
  }
  if (config.label.toLowerCase().includes(keywordLower)) {
    record(50, "label");
  }

  // 40 — env var key substring
  for (const envVar of Object.keys(config.environmentMapping)) {
    if (envVar.toLowerCase().includes(keywordLower)) {
      record(40, `env:${envVar}`);
      break;
    }
  }

  // 30 — secret name substring (any authMethods[*].secrets key)
  for (const method of Object.values(config.authMethods)) {
    let matched = false;
    for (const secretName of Object.keys(method.secrets)) {
      if (secretName.toLowerCase().includes(keywordLower)) {
        record(30, `secret:${secretName}`);
        matched = true;
        break;
      }
    }
    if (matched) break;
  }

  // 25 — tag substring
  if (config.tags) {
    for (const tag of config.tags) {
      if (tag.includes(keywordLower)) {
        record(25, `tag:${tag}`);
        break;
      }
    }
  }

  // 10 × |intersection| — token-set intersection fallback
  const candidateTokens = new Set<string>();
  for (const t of tokenize(type)) candidateTokens.add(t);
  for (const t of tokenize(config.label)) candidateTokens.add(t);
  for (const envVar of Object.keys(config.environmentMapping)) {
    for (const t of tokenize(envVar)) candidateTokens.add(t);
  }
  for (const method of Object.values(config.authMethods)) {
    for (const secretName of Object.keys(method.secrets)) {
      for (const t of tokenize(secretName)) candidateTokens.add(t);
    }
  }
  if (config.tags) {
    for (const tag of config.tags) {
      for (const t of tokenize(tag)) candidateTokens.add(t);
    }
  }
  let intersection = 0;
  let firstCommon = "";
  for (const t of keywordTokens) {
    if (candidateTokens.has(t)) {
      intersection++;
      if (!firstCommon) firstCommon = t;
    }
  }
  if (intersection > 0) {
    record(10 * intersection, `token:${firstCommon}`);
  }

  if (bestScore < MIN_SCORE) return null;
  return { score: bestScore, matchedField: bestField };
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
  for (const type of Object.keys(CONNECTOR_TYPES) as ConnectorType[]) {
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
