import { eq, and, inArray } from "drizzle-orm";
import {
  CONNECTOR_TYPES,
  type ConnectorAuthMethodType,
  type ConnectorType,
  type ConnectorResponse,
  connectorTypeSchema,
  deriveApiTokenConnectedTypes,
  getApiTokenFieldsByType,
} from "@vm0/core";
import { connectors } from "../../../db/schema/connector";
import { secrets } from "../../../db/schema/secret";
import { variables } from "../../../db/schema/variable";
import { notFound, badRequest } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { getSecretValue, upsertSecretByOrg } from "../secret/secret-service";
import { PROVIDER_HANDLERS } from "./provider-registry";

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
 * Get secret name for a connector type
 */
function getSecretNameForConnector(type: ConnectorType): string {
  if (type === "computer") return "COMPUTER_CONNECTOR_AUTHTOKEN";
  return PROVIDER_HANDLERS[type].getSecretName();
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
 * Returns OAuth connectors from DB plus derived api-token connectors
 * based on user secrets that match api-token required secret names.
 */
export async function listConnectors(
  orgId: string,
  userId: string,
): Promise<ConnectorResponse[]> {
  const db = globalThis.services.db;

  // Query OAuth connectors from DB and derive api-token types in parallel
  const [dbResult, derivedTypes] = await Promise.all([
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
      .where(and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)))
      .orderBy(connectors.type),
    getApiTokenConnectorTypes(orgId, userId),
  ]);

  const dbConnectors: ConnectorResponse[] = dbResult.map((row) => {
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
  });

  // DB record takes precedence over derived
  const dbTypeSet = new Set(
    dbConnectors.map((c) => {
      return c.type;
    }),
  );
  const now = new Date().toISOString();
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
        createdAt: now,
        updatedAt: now,
      };
    });

  return [...dbConnectors, ...derivedConnectors];
}

/**
 * Get a specific connector by type.
 * Returns DB record for OAuth connectors, or derived response for api-token
 * connectors whose required user secrets are all present.
 */
export async function getConnector(
  orgId: string,
  userId: string,
  type: ConnectorType,
): Promise<ConnectorResponse | null> {
  const result = await globalThis.services.db
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

  if (result[0]) {
    const row = result[0];
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

  const now = new Date().toISOString();
  return {
    id: null,
    type,
    authMethod: "api-token",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: now,
    updatedAt: now,
  };
}

interface ExternalUserInfo {
  id: string;
  username: string;
  email: string | null;
}

/**
 * Create or update a connector with OAuth token
 * Also stores the associated secret with type="connector"
 */
export async function upsertOAuthConnector(
  orgId: string,
  userId: string,
  type: ConnectorType,
  accessToken: string,
  userInfo: ExternalUserInfo,
  oauthScopes: string[],
  options?: {
    refreshToken?: string | null;
    refreshSecretName?: string;
    expiresIn?: number;
  },
): Promise<{ connector: ConnectorResponse; created: boolean }> {
  const secretName = getSecretNameForConnector(type);
  const db = globalThis.services.db;
  // Some providers issue non-expiring access tokens (e.g., classic GitHub
  // OAuth apps, legacy Notion) — those handlers omit `refreshToken`, so we
  // keep `tokenExpiresAt` null and the firewall refresh path naturally
  // skips them. For refreshable providers, fall back to 1 h when the
  // exchange response lacks `expires_in` so firewall auth can always judge
  // freshness and never hit the null-skip bug from #9836.
  const isRefreshable =
    type !== "computer" && !!PROVIDER_HANDLERS[type].refreshToken;
  const fallbackSecs = isRefreshable
    ? DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS
    : null;
  const expiresInSecs = options?.expiresIn ?? fallbackSecs;
  const tokenExpiresAt =
    expiresInSecs != null ? new Date(Date.now() + expiresInSecs * 1000) : null;

  // Upsert access token secret
  await upsertSecretByOrg(
    orgId,
    userId,
    secretName,
    accessToken,
    "connector",
    `OAuth token for ${type} connector`,
  );

  // Upsert refresh token secret if provided
  if (options?.refreshToken && options.refreshSecretName) {
    await upsertSecretByOrg(
      orgId,
      userId,
      options.refreshSecretName,
      options.refreshToken,
      "connector",
      `OAuth refresh token for ${type} connector`,
    );
  }

  // Upsert connector
  const [connectorRow] = await db
    .insert(connectors)
    .values({
      userId,
      type,
      authMethod: "oauth",
      externalId: userInfo.id,
      externalUsername: userInfo.username,
      externalEmail: userInfo.email,
      oauthScopes: JSON.stringify(oauthScopes),
      tokenExpiresAt,
      needsReconnect: false,
      orgId,
    })
    .onConflictDoUpdate({
      target: [connectors.orgId, connectors.userId, connectors.type],
      set: {
        authMethod: "oauth",
        externalId: userInfo.id,
        externalUsername: userInfo.username,
        externalEmail: userInfo.email,
        oauthScopes: JSON.stringify(oauthScopes),
        tokenExpiresAt,
        needsReconnect: false,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!connectorRow) {
    throw new Error("Failed to upsert connector");
  }
  log.debug("connector upserted", { connectorId: connectorRow.id, type });

  return {
    connector: {
      id: connectorRow.id,
      type: parseConnectorType(connectorRow.type),
      authMethod: connectorRow.authMethod,
      externalId: connectorRow.externalId,
      externalUsername: connectorRow.externalUsername,
      externalEmail: connectorRow.externalEmail,
      oauthScopes: connectorRow.oauthScopes
        ? JSON.parse(connectorRow.oauthScopes)
        : null,
      needsReconnect: connectorRow.needsReconnect,
      createdAt: connectorRow.createdAt.toISOString(),
      updatedAt: connectorRow.updatedAt.toISOString(),
    },
    // New insert: both timestamps use DB DEFAULT NOW() (same value).
    // Conflict update: updatedAt is set to new Date() in the set clause, so they differ.
    created:
      connectorRow.createdAt.getTime() === connectorRow.updatedAt.getTime(),
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

  const env = globalThis.services.env;
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
 * For OAuth connectors: deletes DB record + connector-type secrets.
 * For api-token connectors (no DB record): deletes user secrets matching required api-token secret names.
 */
export async function deleteConnector(
  orgId: string,
  userId: string,
  type: ConnectorType,
): Promise<void> {
  const db = globalThis.services.db;

  // Check if connector exists in DB (OAuth connectors)
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

    const secretNames: string[] = [];
    const config = CONNECTOR_TYPES[type];
    const authMethodConfig =
      config.authMethods[existing.authMethod as ConnectorAuthMethodType];
    if (authMethodConfig) {
      secretNames.push(...Object.keys(authMethodConfig.secrets));
    }

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
    return;
  }

  // No DB record — check if type supports api-token and delete secrets + variables
  const fields = getApiTokenFieldsByType(type);
  if (fields && (fields.secrets.length > 0 || fields.variables.length > 0)) {
    let deletedAny = false;
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
      if (result.length > 0) deletedAny = true;
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
      if (result.length > 0) deletedAny = true;
    }
    if (deletedAny) {
      log.debug("api-token connector deleted via user secrets/variables", {
        orgId,
        type,
      });
      return;
    }
  }

  throw notFound("Connector not found");
}

/**
 * Generic connector access token refresh.
 * Looks up the connector's handler from PROVIDER_HANDLERS, calls its refreshToken
 * method, persists new tokens, and updates the in-memory secrets map.
 *
 * Returns null if refresh token is unavailable, OAuth credentials are missing,
 * or the refresh fails (caller should fall back to the existing access token).
 */
export async function refreshConnectorAccessToken(
  connectorType: string,
  orgId: string,
  userId: string,
  connectorSecrets: Record<string, string>,
): Promise<string | null> {
  const handler =
    PROVIDER_HANDLERS[connectorType as keyof typeof PROVIDER_HANDLERS];
  if (!handler?.refreshToken || !handler.getRefreshSecretName) {
    return null;
  }

  const refreshTokenSecret = handler.getRefreshSecretName();
  const currentRefreshToken = connectorSecrets[refreshTokenSecret];
  if (!currentRefreshToken) {
    log.debug(`No ${connectorType} refresh token available, skipping`);
    return null;
  }

  const env = globalThis.services.env;
  const clientId = handler.getClientId(env);
  const clientSecret = handler.getClientSecret(env);

  if (!clientId || !clientSecret) {
    log.debug(
      `${connectorType} OAuth credentials not configured, skipping token refresh`,
    );
    return null;
  }

  const accessTokenSecret = handler.getSecretName();

  try {
    const result = await handler.refreshToken(
      clientId,
      clientSecret,
      currentRefreshToken,
    );

    // Persist new tokens to database
    await upsertConnectorSecret(
      orgId,
      userId,
      accessTokenSecret,
      result.accessToken,
    );
    if (result.refreshToken) {
      await upsertConnectorSecret(
        orgId,
        userId,
        refreshTokenSecret,
        result.refreshToken,
      );
    }

    // Update tokenExpiresAt so subsequent expiry checks are accurate.
    const expiresAt = new Date(
      Date.now() +
        (result.expiresIn ?? DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS) * 1000,
    );
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

    // Update in-memory secrets map so subsequent mapping uses fresh token
    connectorSecrets[accessTokenSecret] = result.accessToken;
    if (result.refreshToken) {
      connectorSecrets[refreshTokenSecret] = result.refreshToken;
    }

    log.debug(`${connectorType} access token refreshed successfully`);
    return result.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.warn(`${connectorType} token refresh failed: ${message}`, {
      connectorType,
      orgId,
      userId,
    });

    // Mark connector as needing reconnect so the UI can surface the failure
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
 */
export async function getConnectorAccessToken(
  connectorType: string,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const handler =
    PROVIDER_HANDLERS[connectorType as keyof typeof PROVIDER_HANDLERS];
  if (!handler) return null;
  return getSecretValue(orgId, userId, handler.getSecretName(), "connector");
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
): Promise<{ secretName: string; token: string } | null> {
  const handler =
    PROVIDER_HANDLERS[connectorType as keyof typeof PROVIDER_HANDLERS];
  if (!handler?.getRefreshSecretName) return null;
  const secretName = handler.getRefreshSecretName();
  const token = await getSecretValue(orgId, userId, secretName, "connector");
  if (!token) return null;
  return { secretName, token };
}

/**
 * Create or update a connector secret (e.g., refresh token)
 */
async function upsertConnectorSecret(
  orgId: string,
  userId: string,
  secretName: string,
  secretValue: string,
): Promise<void> {
  await upsertSecretByOrg(
    orgId,
    userId,
    secretName,
    secretValue,
    "connector",
    `Connector secret: ${secretName}`,
  );
}
