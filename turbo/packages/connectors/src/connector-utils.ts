import {
  CONNECTOR_AUTH_METHOD_TYPES,
  CONNECTOR_TYPES,
  connectorTypeSchema,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodType,
  type ConnectorCliAuthConfig,
  type ConnectorCliAuthFlow,
  type ConnectorConfig,
  type ConnectorOAuthConfig,
  type ConnectorSecretConfig,
  type ConnectorType,
} from "./connectors";
import type { FeatureSwitchKey } from "./feature-switch-key";

/**
 * Connector utility vocabulary:
 *
 * - Available auth methods are user-selectable connection flows after
 *   feature-switch filtering.
 * - Runtime available connector types are connector types the current server
 *   environment can offer as connection candidates.
 * - User connected connector types come from persisted OAuth rows or inferred
 *   api-token state from user secrets and variables.
 * - Runtime injection happens later when a run receives env vars, secrets,
 *   variables, and firewall context.
 */

/**
 * Get auth methods for a connector type
 */
export function getConnectorAuthMethods(
  type: ConnectorType,
): Partial<Record<ConnectorAuthMethodType, ConnectorAuthMethodConfig>> {
  return CONNECTOR_TYPES[type].authMethods;
}

/**
 * Get one auth method config for a connector type.
 */
export function getConnectorAuthMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodType,
): ConnectorAuthMethodConfig | undefined {
  return getConnectorAuthMethods(type)[authMethod];
}

/**
 * Get CLI auth flow config for connector types that support provider CLI auth.
 */
export function getConnectorCliAuthConfig(
  type: ConnectorType,
): ConnectorCliAuthConfig | undefined {
  return CONNECTOR_TYPES[type].cliAuth;
}

/**
 * Get the frontend CLI auth flow for connector types that support it.
 */
export function getConnectorCliAuthFlow(
  type: ConnectorType,
): ConnectorCliAuthFlow | undefined {
  return getConnectorCliAuthConfig(type)?.flow;
}

export function getConnectorCliAuthModes(
  type: ConnectorType,
): NonNullable<ConnectorCliAuthConfig["modes"]> {
  return getConnectorCliAuthConfig(type)?.modes ?? [];
}

/**
 * Get default auth method for a connector type
 */
export function getConnectorDefaultAuthMethod(
  type: ConnectorType,
): ConnectorAuthMethodType | undefined {
  return CONNECTOR_TYPES[type].defaultAuthMethod;
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
  authMethod: ConnectorAuthMethodType,
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
  if (policy === "include") {
    return true;
  }
  if (!policy || policy === "exclude") {
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
): ConnectorAuthMethodType[] {
  const apiAuthMethodPolicy = options.apiAuthMethodPolicy ?? "exclude";
  const availableAuthMethods: ConnectorAuthMethodType[] = [];

  for (const authMethod of CONNECTOR_AUTH_METHOD_TYPES) {
    if (!getConnectorAuthMethod(type, authMethod)) {
      continue;
    }
    if (
      authMethod === "api" &&
      !shouldIncludeApiAuthMethod(type, apiAuthMethodPolicy)
    ) {
      continue;
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
  readonly clientSecret: string;
}

const OAUTH_ENV_KEYS_BY_CONNECTOR: Partial<
  Record<ConnectorType, ConnectorOAuthEnvKeys>
> = {
  ahrefs: {
    clientId: "AHREFS_OAUTH_CLIENT_ID",
    clientSecret: "AHREFS_OAUTH_CLIENT_SECRET",
  },
  airtable: {
    clientId: "AIRTABLE_OAUTH_CLIENT_ID",
    clientSecret: "AIRTABLE_OAUTH_CLIENT_SECRET",
  },
  asana: {
    clientId: "ASANA_OAUTH_CLIENT_ID",
    clientSecret: "ASANA_OAUTH_CLIENT_SECRET",
  },
  canva: {
    clientId: "CANVA_OAUTH_CLIENT_ID",
    clientSecret: "CANVA_OAUTH_CLIENT_SECRET",
  },
  close: {
    clientId: "CLOSE_OAUTH_CLIENT_ID",
    clientSecret: "CLOSE_OAUTH_CLIENT_SECRET",
  },
  deel: {
    clientId: "DEEL_OAUTH_CLIENT_ID",
    clientSecret: "DEEL_OAUTH_CLIENT_SECRET",
  },
  docusign: {
    clientId: "DOCUSIGN_OAUTH_CLIENT_ID",
    clientSecret: "DOCUSIGN_OAUTH_CLIENT_SECRET",
  },
  dropbox: {
    clientId: "DROPBOX_OAUTH_CLIENT_ID",
    clientSecret: "DROPBOX_OAUTH_CLIENT_SECRET",
  },
  figma: {
    clientId: "FIGMA_OAUTH_CLIENT_ID",
    clientSecret: "FIGMA_OAUTH_CLIENT_SECRET",
  },
  "garmin-connect": {
    clientId: "GARMIN_CONNECT_OAUTH_CLIENT_ID",
    clientSecret: "GARMIN_CONNECT_OAUTH_CLIENT_SECRET",
  },
  github: {
    clientId: "GH_OAUTH_CLIENT_ID",
    clientSecret: "GH_OAUTH_CLIENT_SECRET",
  },
  gmail: {
    clientId: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  "google-ads": {
    clientId: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  "google-calendar": {
    clientId: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  "google-docs": {
    clientId: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  "google-drive": {
    clientId: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  "google-meet": {
    clientId: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  "google-sheets": {
    clientId: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  gumroad: {
    clientId: "GUMROAD_OAUTH_CLIENT_ID",
    clientSecret: "GUMROAD_OAUTH_CLIENT_SECRET",
  },
  hubspot: {
    clientId: "HUBSPOT_OAUTH_CLIENT_ID",
    clientSecret: "HUBSPOT_OAUTH_CLIENT_SECRET",
  },
  "intervals-icu": {
    clientId: "INTERVALS_ICU_OAUTH_CLIENT_ID",
    clientSecret: "INTERVALS_ICU_OAUTH_CLIENT_SECRET",
  },
  linear: {
    clientId: "LINEAR_OAUTH_CLIENT_ID",
    clientSecret: "LINEAR_OAUTH_CLIENT_SECRET",
  },
  mercury: {
    clientId: "MERCURY_OAUTH_CLIENT_ID",
    clientSecret: "MERCURY_OAUTH_CLIENT_SECRET",
  },
  "meta-ads": {
    clientId: "META_ADS_OAUTH_CLIENT_ID",
    clientSecret: "META_ADS_OAUTH_CLIENT_SECRET",
  },
  monday: {
    clientId: "MONDAY_OAUTH_CLIENT_ID",
    clientSecret: "MONDAY_OAUTH_CLIENT_SECRET",
  },
  neon: {
    clientId: "NEON_OAUTH_CLIENT_ID",
    clientSecret: "NEON_OAUTH_CLIENT_SECRET",
  },
  notion: {
    clientId: "NOTION_OAUTH_CLIENT_ID",
    clientSecret: "NOTION_OAUTH_CLIENT_SECRET",
  },
  "outlook-calendar": {
    clientId: "MICROSOFT_OAUTH_CLIENT_ID",
    clientSecret: "MICROSOFT_OAUTH_CLIENT_SECRET",
  },
  "outlook-mail": {
    clientId: "MICROSOFT_OAUTH_CLIENT_ID",
    clientSecret: "MICROSOFT_OAUTH_CLIENT_SECRET",
  },
  posthog: {
    clientId: "POSTHOG_OAUTH_CLIENT_ID",
    clientSecret: "POSTHOG_OAUTH_CLIENT_SECRET",
  },
  reddit: {
    clientId: "REDDIT_OAUTH_CLIENT_ID",
    clientSecret: "REDDIT_OAUTH_CLIENT_SECRET",
  },
  sentry: {
    clientId: "SENTRY_OAUTH_CLIENT_ID",
    clientSecret: "SENTRY_OAUTH_CLIENT_SECRET",
  },
  slack: {
    clientId: "SLACK_CLIENT_ID",
    clientSecret: "SLACK_CLIENT_SECRET",
  },
  spotify: {
    clientId: "SPOTIFY_OAUTH_CLIENT_ID",
    clientSecret: "SPOTIFY_OAUTH_CLIENT_SECRET",
  },
  strava: {
    clientId: "STRAVA_OAUTH_CLIENT_ID",
    clientSecret: "STRAVA_OAUTH_CLIENT_SECRET",
  },
  stripe: {
    clientId: "STRIPE_OAUTH_CLIENT_ID",
    clientSecret: "STRIPE_OAUTH_CLIENT_SECRET",
  },
  supabase: {
    clientId: "SUPABASE_OAUTH_CLIENT_ID",
    clientSecret: "SUPABASE_OAUTH_CLIENT_SECRET",
  },
  todoist: {
    clientId: "TODOIST_OAUTH_CLIENT_ID",
    clientSecret: "TODOIST_OAUTH_CLIENT_SECRET",
  },
  vercel: {
    clientId: "VERCEL_OAUTH_CLIENT_ID",
    clientSecret: "VERCEL_OAUTH_CLIENT_SECRET",
  },
  webflow: {
    clientId: "WEBFLOW_OAUTH_CLIENT_ID",
    clientSecret: "WEBFLOW_OAUTH_CLIENT_SECRET",
  },
  x: {
    clientId: "X_OAUTH_CLIENT_ID",
    clientSecret: "X_OAUTH_CLIENT_SECRET",
  },
  xero: {
    clientId: "XERO_OAUTH_CLIENT_ID",
    clientSecret: "XERO_OAUTH_CLIENT_SECRET",
  },
  zoom: {
    clientId: "ZOOM_OAUTH_CLIENT_ID",
    clientSecret: "ZOOM_OAUTH_CLIENT_SECRET",
  },
};

const STATIC_OAUTH_CONFIGURED_CONNECTOR_TYPES = new Set<ConnectorType>([
  "test-oauth",
]);

function hasEnvValue(readEnv: ConnectorEnvReader, name: string): boolean {
  return Boolean(readEnv(name));
}

function hasConfiguredOAuth(
  readEnv: ConnectorEnvReader,
  type: ConnectorType,
): boolean {
  if (STATIC_OAUTH_CONFIGURED_CONNECTOR_TYPES.has(type)) {
    return true;
  }
  const keys = OAUTH_ENV_KEYS_BY_CONNECTOR[type];
  return keys
    ? hasEnvValue(readEnv, keys.clientId) &&
        hasEnvValue(readEnv, keys.clientSecret)
    : false;
}

export function getConnectorOAuthEnvKeys(
  type: ConnectorType,
): ConnectorOAuthEnvKeys | undefined {
  return OAUTH_ENV_KEYS_BY_CONNECTOR[type];
}

/**
 * Return connector types the current runtime can offer as connection candidates.
 *
 * This is not user connected state and it does not evaluate feature switches.
 * It includes API-token default connectors because they do not require server
 * credentials, while OAuth connectors require their runtime OAuth env to exist.
 */
export function getRuntimeAvailableConnectorTypes(
  readEnv: ConnectorEnvReader,
): ConnectorType[] {
  const runtimeAvailable = new Set<ConnectorType>();

  for (const type of Object.keys(CONNECTOR_TYPES) as ConnectorType[]) {
    const defaultAuthMethod = getConnectorDefaultAuthMethod(type);
    if (
      hasConfiguredOAuth(readEnv, type) ||
      defaultAuthMethod === "api-token"
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
 * Compatibility wrapper for existing configuredTypes response semantics.
 *
 * The API response field and existing call sites still use "configuredTypes";
 * new connector utility code should prefer getRuntimeAvailableConnectorTypes.
 */
export function getConfiguredConnectorTypes(
  readEnv: ConnectorEnvReader,
): ConnectorType[] {
  return getRuntimeAvailableConnectorTypes(readEnv);
}

/**
 * Get secrets config for a specific auth method
 */
export function getConnectorSecretsForAuthMethod(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodType,
): Record<string, ConnectorSecretConfig> | undefined {
  return getConnectorAuthMethod(type, authMethod)?.secrets;
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
 * Connector types eligible for agent compose without runtime feature context:
 * include connectors with at least one always-available connection flow.
 */
export function getEligibleConnectorTypes(): string[] {
  return Object.entries(CONNECTOR_TYPES)
    .filter(([, config]) => {
      return Object.values(config.authMethods).some((method) => {
        return !method.featureFlag;
      });
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
  const apiTokenConfig = getConnectorAuthMethod(type, "api-token");
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
  const apiTokenConfig = getConnectorAuthMethod(type, "api-token");
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
 * Return the storage target for a connector API-token field.
 *
 * Unknown fields preserve the historical form-submit behavior and are treated
 * as encrypted secrets.
 */
export function getApiTokenFieldStorageType(
  type: ConnectorType,
  name: string,
): "secret" | "variable" {
  const fieldConfig = getConnectorAuthMethod(type, "api-token")?.secrets[name];
  return fieldConfig?.type ?? "secret";
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

function listSecretNames(config: ConnectorConfig): string[] {
  const names: string[] = [];
  for (const method of Object.values(config.authMethods)) {
    for (const name of Object.keys(method.secrets)) {
      names.push(name);
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
  for (const envVar of Object.keys(config.environmentMapping)) {
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
  for (const envVar of Object.keys(config.environmentMapping)) {
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
    ...Object.keys(config.environmentMapping),
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
