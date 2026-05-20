import { eq, and, inArray } from "drizzle-orm";
import {
  deriveApiTokenConnectedTypes,
  getApiTokenFieldsByType,
  getConnectorOAuthCredentials,
  getConnectorSecretNames,
} from "@vm0/connectors/connector-utils";
import type {
  ConnectorAuthMethodType,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { connectorTypeSchema } from "@vm0/connectors/connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { connectors } from "@vm0/db/schema/connector";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { notFound, badRequest } from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";
import { getSecretValue, upsertSecretByOrg } from "../secret/secret-service";
import {
  PROVIDER_HANDLERS,
  providerEnvFromObject,
  refreshProviderToken,
} from "@vm0/connectors/oauth-providers";
import type {
  OAuthRefreshResult,
  ProviderHandler as ConnectorProviderHandler,
} from "@vm0/connectors/oauth-providers/provider-types";
import {
  getModelProviderOAuthHandler,
  type ModelProviderOAuthHandler,
} from "@vm0/connectors/oauth-providers/model-provider-registry";
import { isChatgptRefreshError } from "@vm0/connectors/oauth-providers/providers/codex-oauth";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { publishUserSignal } from "../../infra/realtime/client";

/**
 * Source for an OAuth secret bundle. "connector" (default) reads/writes
 * connector-typed rows keyed by the run's user; "model-provider" routes to
 * `model_providers` and `secrets WHERE type='model-provider'`.
 */
export type OAuthSecretSource = "connector" | "model-provider";

type OAuthHandler = ConnectorProviderHandler | ModelProviderOAuthHandler;

function getOAuthHandler(
  handlerKey: string,
  sourceType: OAuthSecretSource,
): OAuthHandler | undefined {
  if (sourceType === "model-provider") {
    return getModelProviderOAuthHandler(handlerKey);
  }
  return PROVIDER_HANDLERS[handlerKey as keyof typeof PROVIDER_HANDLERS];
}

function isConnectorOAuthHandler(
  handler: OAuthHandler,
): handler is ConnectorProviderHandler {
  return "buildAuthUrl" in handler && "exchangeCode" in handler;
}

interface OAuthClientCredentials {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
}

function resolveConnectorRefreshCredentials(
  connectorType: string,
): OAuthClientCredentials | null {
  const typeResult = connectorTypeSchema.safeParse(connectorType);
  if (!typeResult.success) {
    log.debug(`${connectorType} is not a connector type, skipping`);
    return null;
  }

  const env = providerEnvFromObject(globalThis.services.env);
  const credentials = getConnectorOAuthCredentials(typeResult.data, (name) => {
    return env[name];
  });
  if (!credentials?.configured) {
    log.debug(
      `${connectorType} OAuth credentials not configured, skipping token refresh`,
    );
    return null;
  }

  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  };
}

function resolveModelProviderRefreshCredentials(
  connectorType: string,
  handler: OAuthHandler,
): OAuthClientCredentials | null {
  const env = providerEnvFromObject(globalThis.services.env);
  const clientId = handler.getClientId(env);
  if (!clientId) {
    log.debug(
      `${connectorType} OAuth client ID not configured, skipping token refresh`,
    );
    return null;
  }

  return {
    clientId,
    clientSecret: handler.getClientSecret(env),
  };
}

function resolveRefreshOAuthCredentials(args: {
  readonly connectorType: string;
  readonly sourceType: OAuthSecretSource;
  readonly handler: OAuthHandler;
}): OAuthClientCredentials | null {
  if (args.sourceType === "connector") {
    return resolveConnectorRefreshCredentials(args.connectorType);
  }
  return resolveModelProviderRefreshCredentials(
    args.connectorType,
    args.handler,
  );
}

async function refreshOAuthToken(args: {
  readonly sourceType: OAuthSecretSource;
  readonly handler: OAuthHandler;
  readonly credentials: OAuthClientCredentials;
  readonly refreshToken: string;
}): Promise<OAuthRefreshResult> {
  if (args.sourceType === "model-provider") {
    if (args.handler.refreshTokenWithArgs) {
      return await args.handler.refreshTokenWithArgs({
        clientId: args.credentials.clientId,
        clientSecret: args.credentials.clientSecret,
        refreshToken: args.refreshToken,
      });
    }
    if (!args.handler.refreshToken) {
      throw new Error("Model provider handler does not support token refresh");
    }
    return await args.handler.refreshToken(
      args.credentials.clientId ?? "",
      args.credentials.clientSecret ?? "",
      args.refreshToken,
    );
  }

  if (!isConnectorOAuthHandler(args.handler)) {
    throw new Error("Connector OAuth handler missing authorization methods");
  }

  return await refreshProviderToken(args.handler, {
    clientId: args.credentials.clientId,
    clientSecret: args.credentials.clientSecret,
    refreshToken: args.refreshToken,
  });
}

/**
 * Resolve the storage userId for a given OAuth secret source.
 * Model-provider refresh defaults to the org sentinel for compatibility, but
 * personal providers pass their row owner explicitly through the firewall
 * refresh metadata.
 */
function resolveSecretUserId(
  sourceType: OAuthSecretSource,
  userId: string,
  sourceUserId?: string,
): string {
  if (sourceType === "model-provider") {
    return sourceUserId ?? ORG_SENTINEL_USER_ID;
  }
  return userId;
}

const log = logger("service:connector");

/**
 * Fallback access-token lifetime (seconds) when a provider omits `expires_in`.
 * 1 hour matches every OAuth provider we integrate (Google, Notion, etc.), and
 * guarantees `tokenExpiresAt` is never null so the firewall auth endpoint can
 * always judge freshness and trigger a refresh. See #9836.
 */
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS = 3600;

/**
 * Validate and parse connector type from database value
 */
function parseConnectorType(type: string): ConnectorType {
  const result = connectorTypeSchema.safeParse(type);
  if (!result.success) {
    throw badRequest(`Invalid connector type: ${type}`);
  }
  return result.data;
}

/**
 * Derive api-token connector types from user secrets and variables.
 * API-token connectors don't have DB records — their existence is inferred
 * from matching user secrets/variables.
 */
export async function getApiTokenConnectorTypes(
  orgId: string,
  userId: string,
): Promise<ConnectorType[]> {
  const db = globalThis.services.db;
  const [userSecretRows, userVariableRows] = await Promise.all([
    db
      .select({ name: secrets.name })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.type, "user"),
        ),
      ),
    db
      .select({ name: variables.name })
      .from(variables)
      .where(and(eq(variables.orgId, orgId), eq(variables.userId, userId))),
  ]);
  return deriveApiTokenConnectedTypes(
    new Set(
      userSecretRows.map((r) => {
        return r.name;
      }),
    ),
    new Set(
      userVariableRows.map((r) => {
        return r.name;
      }),
    ),
  );
}

/**
 * List all connectors for an org.
 * Merges OAuth rows from `connectors` with api-token connectors derived from
 * user secrets that match api-token required secret names.
 */
export async function listConnectors(
  orgId: string,
  userId: string,
): Promise<ConnectorResponse[]> {
  const db = globalThis.services.db;

  const [oauthRows, derivedTypes] = await Promise.all([
    db
      .select({
        id: connectors.id,
        type: connectors.type,
        authMethod: connectors.authMethod,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
        oauthScopes: connectors.oauthScopes,
        needsReconnect: connectors.needsReconnect,
        createdAt: connectors.createdAt,
        updatedAt: connectors.updatedAt,
      })
      .from(connectors)
      .where(and(eq(connectors.orgId, orgId), eq(connectors.userId, userId))),
    getApiTokenConnectorTypes(orgId, userId),
  ]);

  // `connectors.type` is varchar, so it can outlive a connector's removal from
  // the contract. Skip unknown types instead of throwing, so the list endpoint
  // stays usable while ops cleans up orphans.
  const dbConnectors: ConnectorResponse[] = oauthRows.flatMap((row) => {
    const parsed = connectorTypeSchema.safeParse(row.type);
    if (!parsed.success) return [];
    return [
      {
        id: row.id,
        type: parsed.data,
        authMethod: row.authMethod,
        externalId: row.externalId,
        externalUsername: row.externalUsername,
        externalEmail: row.externalEmail,
        oauthScopes: row.oauthScopes ? JSON.parse(row.oauthScopes) : null,
        needsReconnect: row.needsReconnect,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    ];
  });

  // DB record takes precedence over derived
  const dbTypeSet = new Set(
    dbConnectors.map((c) => {
      return c.type;
    }),
  );
  // Use a fixed timestamp for derived connectors — they are inferred from
  // secrets/variables rather than explicitly created, so a stable sentinel
  // value keeps shadow comparisons deterministic.
  const derivedConnectors: ConnectorResponse[] = derivedTypes
    .filter((type) => {
      return !dbTypeSet.has(type);
    })
    .map((type) => {
      return {
        id: null,
        type,
        authMethod: "api-token",
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        needsReconnect: false,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      };
    });

  return [...dbConnectors, ...derivedConnectors];
}

/**
 * Get a specific connector by type.
 * Returns the DB record for OAuth (from `connectors`) or a derived response for
 * api-token connectors whose required user secrets are all present.
 */
export async function getConnector(
  orgId: string,
  userId: string,
  type: ConnectorType,
): Promise<ConnectorResponse | null> {
  const db = globalThis.services.db;

  const oauthResult = await db
    .select({
      id: connectors.id,
      type: connectors.type,
      authMethod: connectors.authMethod,
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
      oauthScopes: connectors.oauthScopes,
      needsReconnect: connectors.needsReconnect,
      createdAt: connectors.createdAt,
      updatedAt: connectors.updatedAt,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        eq(connectors.type, type),
      ),
    )
    .limit(1);

  if (oauthResult[0]) {
    const row = oauthResult[0];
    return {
      id: row.id,
      type: parseConnectorType(row.type),
      authMethod: row.authMethod,
      externalId: row.externalId,
      externalUsername: row.externalUsername,
      externalEmail: row.externalEmail,
      oauthScopes: row.oauthScopes ? JSON.parse(row.oauthScopes) : null,
      needsReconnect: row.needsReconnect,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // Check if type supports api-token and all required fields exist
  const fields = getApiTokenFieldsByType(type);
  if (!fields || (fields.secrets.length === 0 && fields.variables.length === 0))
    return null;

  const [userSecretRows, userVariableRows] = await Promise.all([
    fields.secrets.length > 0
      ? globalThis.services.db
          .select({ name: secrets.name })
          .from(secrets)
          .where(
            and(
              eq(secrets.orgId, orgId),
              eq(secrets.userId, userId),
              eq(secrets.type, "user"),
            ),
          )
      : Promise.resolve([]),
    fields.variables.length > 0
      ? globalThis.services.db
          .select({ name: variables.name })
          .from(variables)
          .where(and(eq(variables.orgId, orgId), eq(variables.userId, userId)))
      : Promise.resolve([]),
  ]);

  const userSecretNames = new Set(
    userSecretRows.map((r) => {
      return r.name;
    }),
  );
  const userVariableNames = new Set(
    userVariableRows.map((r) => {
      return r.name;
    }),
  );
  const secretsOk = fields.secrets.every((name) => {
    return userSecretNames.has(name);
  });
  const variablesOk = fields.variables.every((name) => {
    return userVariableNames.has(name);
  });
  if (!secretsOk || !variablesOk) return null;

  // Use a fixed timestamp — this connector is inferred, not explicitly created.
  return {
    id: null,
    type,
    authMethod: "api-token",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

/**
 * Best-effort revocation of an OAuth provider's remote token/grant.
 * Looks up the connector's handler, reads the access token from DB,
 * and calls the handler's revokeToken method if available.
 * Errors are logged and swallowed — revocation must never block disconnect.
 */
export async function revokeConnectorToken(
  orgId: string,
  userId: string,
  type: ConnectorType,
): Promise<void> {
  if (type === "computer") return;

  const handler = PROVIDER_HANDLERS[type as Exclude<ConnectorType, "computer">];
  if (!handler.revokeToken) return;

  const env = providerEnvFromObject(globalThis.services.env);
  const clientId = handler.getClientId(env);
  const clientSecret = handler.getClientSecret(env);
  if (!clientId || !clientSecret) {
    log.debug(
      `${type} OAuth credentials not configured, skipping token revocation`,
    );
    return;
  }

  const accessTokenName = handler.getSecretName();
  const accessToken = await getSecretValue(
    orgId,
    userId,
    accessTokenName,
    "connector",
  );
  if (!accessToken) {
    log.debug(`${type} access token not found, skipping revocation`);
    return;
  }

  try {
    await handler.revokeToken(clientId, clientSecret, accessToken);
    log.debug(`${type} token revoked successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn(`${type} token revocation failed: ${message}`);
  }
}

/**
 * Delete a connector and its associated secrets.
 * - OAuth connectors: revoke remote token (best-effort), delete DB row +
 *   connector-type secrets (access + refresh).
 * - API-token connectors (no DB row): delete user secrets/variables that
 *   match the api-token requirement for this type.
 */
export async function deleteConnector(
  orgId: string,
  userId: string,
  type: ConnectorType,
): Promise<void> {
  const db = globalThis.services.db;
  let deleted = false;

  // Check if connector exists in `connectors` (OAuth) table
  const [existing] = await db
    .select({ id: connectors.id, authMethod: connectors.authMethod })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        eq(connectors.type, type),
      ),
    )
    .limit(1);

  if (existing) {
    // Revoke remote token before deleting local state (best-effort)
    if (existing.authMethod === "oauth") {
      await revokeConnectorToken(orgId, userId, type);
    }

    // OAuth connector: delete DB record + connector-type secrets
    await db.delete(connectors).where(eq(connectors.id, existing.id));

    const secretNames = getConnectorSecretNames(
      type,
      existing.authMethod as ConnectorAuthMethodType,
    );

    if (existing.authMethod === "oauth" && type !== "computer") {
      const handler =
        PROVIDER_HANDLERS[type as Exclude<ConnectorType, "computer">];
      const refreshSecretName = handler.getRefreshSecretName?.();
      if (refreshSecretName) {
        secretNames.push(refreshSecretName);
      }
    }

    for (const name of secretNames) {
      await db
        .delete(secrets)
        .where(
          and(
            eq(secrets.orgId, orgId),
            eq(secrets.userId, userId),
            eq(secrets.name, name),
            eq(secrets.type, "connector"),
          ),
        );
    }

    log.debug("connector deleted", { orgId, type });
    deleted = true;
  }

  // Always clean up api-token secrets/variables, even if an OAuth record was
  // already deleted above. A connector can legitimately hold both credential
  // forms during migrations or manual repairs, so a DELETE must remove every
  // trace or the UI will still treat the connector as connected via the
  // leftover secret.
  const fields = getApiTokenFieldsByType(type);
  if (fields) {
    for (const name of fields.secrets) {
      const result = await db
        .delete(secrets)
        .where(
          and(
            eq(secrets.orgId, orgId),
            eq(secrets.userId, userId),
            eq(secrets.name, name),
            eq(secrets.type, "user"),
          ),
        )
        .returning({ id: secrets.id });
      if (result.length > 0) deleted = true;
    }
    for (const name of fields.variables) {
      const result = await db
        .delete(variables)
        .where(
          and(
            eq(variables.orgId, orgId),
            eq(variables.userId, userId),
            eq(variables.name, name),
          ),
        )
        .returning({ id: variables.id });
      if (result.length > 0) deleted = true;
    }
  }

  if (!deleted) {
    throw notFound("Connector not found");
  }

  await publishUserSignal([userId], "connector:changed");
}

/**
 * Generic connector access token refresh.
 * Looks up the connector's handler from PROVIDER_HANDLERS, calls its refreshToken
 * method, persists new tokens, and updates the in-memory secrets map.
 *
 * `sourceType` selects which DB rows to read/write:
 *   - "connector"      → secrets type='connector', metadata on `connectors`
 *   - "model-provider" → secrets type='model-provider', metadata on `model_providers`
 * For "model-provider", `metadataKey` must be the model-provider type
 * (e.g. "codex-oauth-token") used to locate the metadata row.
 *
 * Returns null if refresh token is unavailable, OAuth credentials are missing,
 * or the refresh fails (caller should fall back to the existing access token).
 */
export async function refreshConnectorAccessToken(
  connectorType: string,
  orgId: string,
  userId: string,
  connectorSecrets: Record<string, string>,
  options: {
    sourceType?: OAuthSecretSource;
    metadataKey?: string;
    sourceUserId?: string;
  } = {},
): Promise<string | null> {
  const sourceType: OAuthSecretSource = options.sourceType ?? "connector";
  const handler = getOAuthHandler(connectorType, sourceType);
  if (
    !handler?.getRefreshSecretName ||
    (!handler.refreshToken && !handler.refreshTokenWithArgs)
  ) {
    return null;
  }
  if (sourceType === "model-provider" && !options.metadataKey) {
    throw new Error(
      `metadataKey required for model-provider source on ${connectorType}`,
    );
  }

  const refreshTokenSecret = handler.getRefreshSecretName();
  const currentRefreshToken = connectorSecrets[refreshTokenSecret];
  if (!currentRefreshToken) {
    log.debug(`No ${connectorType} refresh token available, skipping`);
    return null;
  }

  const credentials = resolveRefreshOAuthCredentials({
    connectorType,
    sourceType,
    handler,
  });
  if (!credentials) {
    return null;
  }

  const accessTokenSecret = handler.getSecretName();

  const secretUserId = resolveSecretUserId(
    sourceType,
    userId,
    options.sourceUserId,
  );

  try {
    const result = await refreshOAuthToken({
      sourceType,
      handler,
      credentials,
      refreshToken: currentRefreshToken,
    });

    // Persist new tokens to database
    await upsertConnectorSecret(
      orgId,
      secretUserId,
      accessTokenSecret,
      result.accessToken,
      sourceType,
    );
    if (result.refreshToken) {
      await upsertConnectorSecret(
        orgId,
        secretUserId,
        refreshTokenSecret,
        result.refreshToken,
        sourceType,
      );
    }

    // Update tokenExpiresAt so subsequent expiry checks are accurate.
    const expiresAt = new Date(
      Date.now() +
        (result.expiresIn ?? DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS) * 1000,
    );
    if (sourceType === "model-provider") {
      await globalThis.services.db
        .update(modelProviders)
        .set({
          tokenExpiresAt: expiresAt,
          needsReconnect: false,
          lastRefreshErrorCode: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(modelProviders.orgId, orgId),
            eq(modelProviders.userId, secretUserId),
            // metadataKey is non-null due to the upfront guard
            eq(modelProviders.type, options.metadataKey!),
          ),
        );
    } else {
      await globalThis.services.db
        .update(connectors)
        .set({ tokenExpiresAt: expiresAt, updatedAt: new Date() })
        .where(
          and(
            eq(connectors.orgId, orgId),
            eq(connectors.userId, userId),
            eq(connectors.type, connectorType),
          ),
        );
    }

    // Update in-memory secrets map so subsequent mapping uses fresh token
    connectorSecrets[accessTokenSecret] = result.accessToken;
    if (result.refreshToken) {
      connectorSecrets[refreshTokenSecret] = result.refreshToken;
    }

    log.debug(`${connectorType} access token refreshed successfully`);
    return result.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Preserve typed error codes so Wave 3 stale-UX can render the right CTA.
    const errorCode = isChatgptRefreshError(err) ? err.code : null;
    log.warn(`${connectorType} token refresh failed: ${message}`, {
      connectorType,
      orgId,
      userId,
      errorCode,
    });

    // Mark provider/connector as needing reconnect so the UI can surface the
    // failure. For model-provider sources, also persist the typed error code.
    if (sourceType === "model-provider") {
      await globalThis.services.db
        .update(modelProviders)
        .set({
          needsReconnect: true,
          lastRefreshErrorCode: errorCode,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(modelProviders.orgId, orgId),
            eq(modelProviders.userId, secretUserId),
            eq(modelProviders.type, options.metadataKey!),
          ),
        );
    } else {
      await globalThis.services.db
        .update(connectors)
        .set({ needsReconnect: true, updatedAt: new Date() })
        .where(
          and(
            eq(connectors.orgId, orgId),
            eq(connectors.userId, userId),
            eq(connectors.type, connectorType),
          ),
        );
    }
    return null;
  }
}

/**
 * Get tokenExpiresAt for connectors matching the given types.
 * Returns a map of connector type → expiry timestamp (epoch seconds), or null if non-expiring.
 */
export async function getConnectorExpiry(
  orgId: string,
  userId: string,
  connectorTypes: string[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (connectorTypes.length === 0) return result;

  const rows = await globalThis.services.db
    .select({
      type: connectors.type,
      tokenExpiresAt: connectors.tokenExpiresAt,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        inArray(connectors.type, connectorTypes),
      ),
    );

  for (const row of rows) {
    result.set(
      row.type,
      row.tokenExpiresAt
        ? Math.floor(row.tokenExpiresAt.getTime() / 1000)
        : null,
    );
  }
  return result;
}

/**
 * Read the current access token for a connector type from the secrets store.
 * Does NOT trigger a refresh — returns the latest persisted value.
 *
 * `sourceType` selects the secrets row's `type` column ("connector" by
 * default; "model-provider" for handler keys backing model-provider OAuth).
 */
export async function getConnectorAccessToken(
  connectorType: string,
  orgId: string,
  userId: string,
  sourceType: OAuthSecretSource = "connector",
  options: { sourceUserId?: string } = {},
): Promise<string | null> {
  const handler = getOAuthHandler(connectorType, sourceType);
  if (!handler) return null;
  return getSecretValue(
    orgId,
    resolveSecretUserId(sourceType, userId, options.sourceUserId),
    handler.getSecretName(),
    sourceType,
  );
}

/**
 * Read the current refresh token for a connector type from the secrets store.
 * Does NOT trigger a refresh — returns the latest persisted value.
 * Returns null if the connector has no refresh token support or no stored value.
 */
export async function getConnectorRefreshToken(
  connectorType: string,
  orgId: string,
  userId: string,
  sourceType: OAuthSecretSource = "connector",
  options: { sourceUserId?: string } = {},
): Promise<{ secretName: string; token: string } | null> {
  const handler = getOAuthHandler(connectorType, sourceType);
  if (!handler?.getRefreshSecretName) return null;
  const secretName = handler.getRefreshSecretName();
  const token = await getSecretValue(
    orgId,
    resolveSecretUserId(sourceType, userId, options.sourceUserId),
    secretName,
    sourceType,
  );
  if (!token) return null;
  return { secretName, token };
}

/**
 * Get tokenExpiresAt for model providers matching the given types.
 * Returns a map of model-provider type → expiry timestamp (epoch seconds), or
 * null if non-expiring/unknown. Mirrors `getConnectorExpiry` for model-provider
 * sources (e.g., codex-oauth-token).
 */
export async function getModelProviderExpiry(
  orgId: string,
  userId: string,
  modelProviderTypes: string[],
  options: { sourceUserId?: string } = {},
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (modelProviderTypes.length === 0) return result;

  const rows = await globalThis.services.db
    .select({
      type: modelProviders.type,
      tokenExpiresAt: modelProviders.tokenExpiresAt,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(
          modelProviders.userId,
          resolveSecretUserId("model-provider", userId, options.sourceUserId),
        ),
        inArray(modelProviders.type, modelProviderTypes),
      ),
    );

  for (const row of rows) {
    result.set(
      row.type,
      row.tokenExpiresAt
        ? Math.floor(row.tokenExpiresAt.getTime() / 1000)
        : null,
    );
  }
  return result;
}

/**
 * Create or update a connector or model-provider OAuth secret
 * (e.g., access token, rotated refresh token).
 */
async function upsertConnectorSecret(
  orgId: string,
  userId: string,
  secretName: string,
  secretValue: string,
  sourceType: OAuthSecretSource = "connector",
): Promise<void> {
  await upsertSecretByOrg(
    orgId,
    userId,
    secretName,
    secretValue,
    sourceType,
    sourceType === "model-provider"
      ? `Model provider OAuth secret: ${secretName}`
      : `Connector secret: ${secretName}`,
  );
}
