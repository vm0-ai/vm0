import { eq, and } from "drizzle-orm";
import {
  type ConnectorType,
  type ConnectorResponse,
  connectorTypeSchema,
} from "@vm0/core";
import { connectors } from "../../db/schema/connector";
import { secrets } from "../../db/schema/secret";
import { encryptCredentialValue } from "../crypto";
import { notFound, badRequest } from "../errors";
import { logger } from "../logger";
import { getUserScopeByClerkId } from "../scope/scope-service";
import { getGitHubSecretName } from "./providers/github";
import { getNotionSecretName } from "./providers/notion";

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
  switch (type) {
    case "github":
      return getGitHubSecretName();
    case "notion":
      return getNotionSecretName();
    case "computer":
      return "COMPUTER_CONNECTOR_AUTHTOKEN";
  }
}

/**
 * List all connectors for a user
 */
export async function listConnectors(
  clerkUserId: string,
): Promise<ConnectorResponse[]> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return [];
  }

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
    .where(eq(connectors.scopeId, scope.id))
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
  clerkUserId: string,
  type: ConnectorType,
): Promise<ConnectorResponse | null> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return null;
  }

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
    .where(and(eq(connectors.scopeId, scope.id), eq(connectors.type, type)))
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
  clerkUserId: string,
  type: ConnectorType,
  accessToken: string,
  userInfo: ExternalUserInfo,
  oauthScopes: string[],
): Promise<{ connector: ConnectorResponse; created: boolean }> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("User scope not found");
  }

  const secretName = getSecretNameForConnector(type);
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptCredentialValue(accessToken, encryptionKey);

  // Use transaction to ensure atomicity
  const db = globalThis.services.db;

  // Check if connector exists
  const existingConnector = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.scopeId, scope.id), eq(connectors.type, type)))
    .limit(1);

  const isUpdate = existingConnector.length > 0;

  // Upsert secret with type="connector"
  const existingSecret = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.scopeId, scope.id),
        eq(secrets.name, secretName),
        eq(secrets.type, "connector"),
      ),
    )
    .limit(1);

  if (existingSecret[0]) {
    await db
      .update(secrets)
      .set({
        encryptedValue,
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, existingSecret[0].id));
  } else {
    await db.insert(secrets).values({
      scopeId: scope.id,
      name: secretName,
      encryptedValue,
      type: "connector",
      description: `OAuth token for ${type} connector`,
    });
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
        scopeId: scope.id,
        type,
        authMethod: "oauth",
        externalId: userInfo.id,
        externalUsername: userInfo.username,
        externalEmail: userInfo.email,
        oauthScopes: JSON.stringify(oauthScopes),
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
  clerkUserId: string,
  type: ConnectorType,
): Promise<void> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("Connector not found");
  }

  const secretName = getSecretNameForConnector(type);
  const db = globalThis.services.db;

  // Check if connector exists
  const [existing] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.scopeId, scope.id), eq(connectors.type, type)))
    .limit(1);

  if (!existing) {
    throw notFound("Connector not found");
  }

  // Delete connector
  await db.delete(connectors).where(eq(connectors.id, existing.id));

  // Delete associated secret
  await db
    .delete(secrets)
    .where(
      and(
        eq(secrets.scopeId, scope.id),
        eq(secrets.name, secretName),
        eq(secrets.type, "connector"),
      ),
    );

  log.debug("connector deleted", { scopeId: scope.id, type });
}

/**
 * Create or update a connector secret (e.g., refresh token)
 */
export async function upsertConnectorSecret(
  clerkUserId: string,
  secretName: string,
  secretValue: string,
): Promise<void> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("User scope not found");
  }

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptCredentialValue(secretValue, encryptionKey);
  const db = globalThis.services.db;

  const existingSecret = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.scopeId, scope.id),
        eq(secrets.name, secretName),
        eq(secrets.type, "connector"),
      ),
    )
    .limit(1);

  if (existingSecret[0]) {
    await db
      .update(secrets)
      .set({ encryptedValue, updatedAt: new Date() })
      .where(eq(secrets.id, existingSecret[0].id));
  } else {
    await db.insert(secrets).values({
      scopeId: scope.id,
      name: secretName,
      encryptedValue,
      type: "connector",
      description: `Connector secret: ${secretName}`,
    });
  }
}
