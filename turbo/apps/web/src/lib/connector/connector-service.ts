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
import { getNangoIntegrationId } from "./platform/nango";

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
    case "gmail":
      return "GMAIL_ACCESS_TOKEN";
  }
}

/**
 * List all connectors for a user
 *
 * This function syncs Nango connections to the database automatically.
 * When Nango connections are found that don't exist in our database,
 * they are automatically saved so that Platform UI shows the correct state.
 */
export async function listConnectors(
  clerkUserId: string,
): Promise<ConnectorResponse[]> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return [];
  }

  // Sync Nango connections before querying database
  await syncNangoConnections(clerkUserId, scope.id);

  const result = await globalThis.services.db
    .select({
      id: connectors.id,
      type: connectors.type,
      authMethod: connectors.authMethod,
      platform: connectors.platform,
      nangoConnectionId: connectors.nangoConnectionId,
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
    platform: row.platform as "self-hosted" | "nango",
    nangoConnectionId: row.nangoConnectionId,
    externalId: row.externalId,
    externalUsername: row.externalUsername,
    externalEmail: row.externalEmail,
    oauthScopes: row.oauthScopes ? JSON.parse(row.oauthScopes) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Parse connector type from Nango connection tags
 */
function parseConnectorTypeFromTags(nangoConn: {
  tags?: { connection_id?: string };
}): ConnectorType | null {
  const ourConnectionId = nangoConn.tags?.connection_id as string | undefined;
  if (!ourConnectionId) {
    return null;
  }

  const [, connectorTypeStr] = ourConnectionId.split(":");
  if (!connectorTypeStr) {
    return null;
  }

  const typeResult = connectorTypeSchema.safeParse(connectorTypeStr);
  return typeResult.success ? typeResult.data : null;
}

/**
 * Extract user info from Nango connection
 */
function extractUserInfo(
  fullConn: { metadata?: unknown; credentials?: unknown },
  fallbackId: string,
): {
  externalId: string;
  externalUsername: string;
  externalEmail: string | null;
  scopes: string[];
} {
  const metadata = fullConn.metadata;
  const credentials = fullConn.credentials;

  const externalId =
    (metadata as { user_id?: string })?.user_id ??
    (metadata as { id?: string })?.id ??
    (credentials as { id?: string })?.id ??
    fallbackId;

  const externalUsername =
    (metadata as { name?: string })?.name ??
    (metadata as { username?: string })?.username ??
    (credentials as { name?: string })?.name ??
    "";

  const externalEmail =
    (metadata as { email?: string })?.email ??
    (credentials as { email?: string })?.email ??
    null;

  const scopes = (credentials as { scope?: string })?.scope?.split(" ") ?? [];

  return { externalId, externalUsername, externalEmail, scopes };
}

/**
 * Sync Nango connections to our database
 *
 * Queries Nango API for connections belonging to this user (scopeId)
 * and saves any new connections to our database automatically.
 */
async function syncNangoConnections(
  clerkUserId: string,
  scopeId: string,
): Promise<void> {
  const env = globalThis.services.env;
  if (!env.FEATURE_NANGO_ENABLED) {
    return;
  }

  try {
    const nango = globalThis.services.nango;
    const response = await nango.listConnections();

    const userConnections = response.connections.filter(
      (conn: { end_user?: { id?: string } | null }) =>
        conn.end_user?.id === scopeId,
    );

    if (userConnections.length === 0) {
      return;
    }

    log.debug("Found Nango connections for user", {
      scopeId,
      count: userConnections.length,
    });

    for (const nangoConn of userConnections) {
      const connectorType = parseConnectorTypeFromTags(nangoConn);
      if (!connectorType) {
        continue;
      }

      const existing = await globalThis.services.db
        .select({ id: connectors.id })
        .from(connectors)
        .where(
          and(
            eq(connectors.scopeId, scopeId),
            eq(connectors.type, connectorType),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        continue;
      }

      log.info("Syncing new Nango connection to database", {
        scopeId,
        type: connectorType,
        nangoConnectionId: nangoConn.connection_id,
      });

      const fullConn = await nango.getConnection(
        nangoConn.provider_config_key,
        nangoConn.connection_id,
      );

      const userInfo = extractUserInfo(fullConn, nangoConn.connection_id);

      await upsertOAuthConnector(
        clerkUserId,
        connectorType,
        "",
        {
          id: userInfo.externalId,
          username: userInfo.externalUsername,
          email: userInfo.externalEmail,
        },
        userInfo.scopes,
        "nango",
        nangoConn.connection_id,
      );
    }
  } catch (error) {
    log.warn("Failed to sync Nango connections", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
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
      platform: connectors.platform,
      nangoConnectionId: connectors.nangoConnectionId,
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
    platform: row.platform as "self-hosted" | "nango",
    nangoConnectionId: row.nangoConnectionId,
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
 *
 * @param platform - "self-hosted" or "nango" (defaults to "self-hosted")
 * @param nangoConnectionId - Nango connection ID (only for nango platform)
 */
export async function upsertOAuthConnector(
  clerkUserId: string,
  type: ConnectorType,
  accessToken: string,
  userInfo: ExternalUserInfo,
  oauthScopes: string[],
  platform: "self-hosted" | "nango" = "self-hosted",
  nangoConnectionId?: string,
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
    platform: string;
    externalId: string | null;
    externalUsername: string | null;
    externalEmail: string | null;
    oauthScopes: string | null;
    createdAt: Date;
    updatedAt: Date;
    nangoConnectionId: string | null;
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
        platform,
        nangoConnectionId,
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
        platform,
        nangoConnectionId,
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
      platform: connectorRow.platform as "self-hosted" | "nango",
      externalId: connectorRow.externalId,
      externalUsername: connectorRow.externalUsername,
      externalEmail: connectorRow.externalEmail,
      oauthScopes: connectorRow.oauthScopes
        ? JSON.parse(connectorRow.oauthScopes)
        : null,
      createdAt: connectorRow.createdAt.toISOString(),
      updatedAt: connectorRow.updatedAt.toISOString(),
      nangoConnectionId: connectorRow.nangoConnectionId ?? undefined,
    },
    created: !isUpdate,
  };
}

/**
 * Delete a connector and its associated secret
 * Also deletes the connection from the platform (Nango or self-hosted)
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

  // Check if connector exists and get platform info
  const [existing] = await db
    .select({
      id: connectors.id,
      platform: connectors.platform,
      nangoConnectionId: connectors.nangoConnectionId,
    })
    .from(connectors)
    .where(and(eq(connectors.scopeId, scope.id), eq(connectors.type, type)))
    .limit(1);

  if (!existing) {
    throw notFound("Connector not found");
  }

  // Delete from platform (Nango or self-hosted) if applicable
  if (existing.platform === "nango") {
    if (!existing.nangoConnectionId) {
      throw new Error("Nango connection ID not found in database");
    }

    const nango = globalThis.services.nango;
    // Get integration ID mapping (e.g., "gmail" -> "google-mail")
    const integrationId = getNangoIntegrationId(type);

    await nango.deleteConnection(integrationId, existing.nangoConnectionId);
    log.debug("Nango connection deleted", {
      scopeId: scope.id,
      type,
      nangoConnectionId: existing.nangoConnectionId,
    });
  }

  // Delete connector from database
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
