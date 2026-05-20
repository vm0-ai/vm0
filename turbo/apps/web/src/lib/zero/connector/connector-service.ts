import { eq, and } from "drizzle-orm";
import { deriveApiTokenConnectedTypes } from "@vm0/connectors/connector-utils";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { connectorTypeSchema } from "@vm0/connectors/connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { logger } from "../../shared/logger";
import { getSecretValue } from "../secret/secret-service";
import {
  getConnectorOAuthProviderHandler,
  providerEnvFromObject,
} from "@vm0/connectors/oauth-providers";

const log = logger("service:connector");

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

  const handler = getConnectorOAuthProviderHandler(type);
  if (!handler?.revokeToken) return;

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
