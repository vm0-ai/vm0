import { eq, and } from "drizzle-orm";
import {
  type ConnectorType,
  type ConnectorResponse,
  connectorTypeSchema,
} from "@vm0/core";
import { connectors } from "../../db/schema/connector";
import { secrets } from "../../db/schema/secret";
import { notFound, badRequest } from "../errors";
import { logger } from "../logger";
import { upsertSecretByScope } from "../secret/secret-service";
import { PROVIDER_HANDLERS } from "./provider-registry";

const log = logger("service:connector");

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
 * List all connectors for a scope
 */
export async function listConnectors(
  scopeId: string,
): Promise<ConnectorResponse[]> {
  const result = await globalThis.services.db
    .select({
      id: connectors.id,
      type: connectors.type,
      authMethod: connectors.authMethod,
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
      oauthScopes: connectors.oauthScopes,
      createdAt: connectors.createdAt,
      updatedAt: connectors.updatedAt,
    })
    .from(connectors)
    .where(eq(connectors.scopeId, scopeId))
    .orderBy(connectors.type);

  return result.map((row) => ({
    id: row.id,
    type: parseConnectorType(row.type),
    authMethod: row.authMethod,
    externalId: row.externalId,
    externalUsername: row.externalUsername,
    externalEmail: row.externalEmail,
    oauthScopes: row.oauthScopes ? JSON.parse(row.oauthScopes) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Get a specific connector by type
 */
export async function getConnector(
  scopeId: string,
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
      createdAt: connectors.createdAt,
      updatedAt: connectors.updatedAt,
    })
    .from(connectors)
    .where(and(eq(connectors.scopeId, scopeId), eq(connectors.type, type)))
    .limit(1);

  if (!result[0]) {
    return null;
  }

  const row = result[0];
  return {
    id: row.id,
    type: parseConnectorType(row.type),
    authMethod: row.authMethod,
    externalId: row.externalId,
    externalUsername: row.externalUsername,
    externalEmail: row.externalEmail,
    oauthScopes: row.oauthScopes ? JSON.parse(row.oauthScopes) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
  scopeId: string,
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
  const tokenExpiresAt =
    options?.expiresIn != null
      ? new Date(Date.now() + options.expiresIn * 1000)
      : null;

  // Check if connector exists
  const existingConnector = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.scopeId, scopeId), eq(connectors.type, type)))
    .limit(1);

  const isUpdate = existingConnector.length > 0;

  // Upsert access token secret
  await upsertSecretByScope(
    scopeId,
    secretName,
    accessToken,
    "connector",
    `OAuth token for ${type} connector`,
  );

  // Upsert refresh token secret if provided
  if (options?.refreshToken && options.refreshSecretName) {
    await upsertSecretByScope(
      scopeId,
      options.refreshSecretName,
      options.refreshToken,
      "connector",
      `OAuth refresh token for ${type} connector`,
    );
  }

  // Upsert connector
  let connectorRow: {
    id: string;
    type: string;
    authMethod: string;
    externalId: string | null;
    externalUsername: string | null;
    externalEmail: string | null;
    oauthScopes: string | null;
    tokenExpiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

  if (isUpdate) {
    const existingId = existingConnector[0]?.id;
    if (!existingId) {
      throw new Error("Existing connector not found during update");
    }
    const [updated] = await db
      .update(connectors)
      .set({
        authMethod: "oauth",
        externalId: userInfo.id,
        externalUsername: userInfo.username,
        externalEmail: userInfo.email,
        oauthScopes: JSON.stringify(oauthScopes),
        tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(connectors.id, existingId))
      .returning();
    if (!updated) {
      throw new Error("Failed to update connector");
    }
    connectorRow = updated;
    log.debug("connector updated", { connectorId: connectorRow.id, type });
  } else {
    const [created] = await db
      .insert(connectors)
      .values({
        scopeId,
        userId,
        type,
        authMethod: "oauth",
        externalId: userInfo.id,
        externalUsername: userInfo.username,
        externalEmail: userInfo.email,
        oauthScopes: JSON.stringify(oauthScopes),
        tokenExpiresAt,
      })
      .returning();
    if (!created) {
      throw new Error("Failed to create connector");
    }
    connectorRow = created;
    log.debug("connector created", { connectorId: connectorRow.id, type });
  }

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
      createdAt: connectorRow.createdAt.toISOString(),
      updatedAt: connectorRow.updatedAt.toISOString(),
    },
    created: !isUpdate,
  };
}

/**
 * Delete a connector and its associated secret
 */
export async function deleteConnector(
  scopeId: string,
  type: ConnectorType,
): Promise<void> {
  const secretName = getSecretNameForConnector(type);
  const db = globalThis.services.db;

  // Check if connector exists
  const [existing] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.scopeId, scopeId), eq(connectors.type, type)))
    .limit(1);

  if (!existing) {
    throw notFound("Connector not found");
  }

  // Delete connector from database
  await db.delete(connectors).where(eq(connectors.id, existing.id));

  // Delete associated secret
  await db
    .delete(secrets)
    .where(
      and(
        eq(secrets.scopeId, scopeId),
        eq(secrets.name, secretName),
        eq(secrets.type, "connector"),
      ),
    );

  log.debug("connector deleted", { scopeId, type });
}

/**
 * Create or update a connector secret (e.g., refresh token)
 */
export async function upsertConnectorSecret(
  scopeId: string,
  secretName: string,
  secretValue: string,
): Promise<void> {
  await upsertSecretByScope(
    scopeId,
    secretName,
    secretValue,
    "connector",
    `Connector secret: ${secretName}`,
  );
}
