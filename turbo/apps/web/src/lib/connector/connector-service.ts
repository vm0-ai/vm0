import { eq, and } from "drizzle-orm";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  type ConnectorResponse,
  connectorTypeSchema,
  deriveApiTokenConnectedTypes,
  getApiTokenFieldsByType,
} from "@vm0/core";
import { connectors } from "../../db/schema/connector";
import { secrets } from "../../db/schema/secret";
import { variables } from "../../db/schema/variable";
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
 * List all connectors for a scope.
 * Returns OAuth connectors from DB plus derived api-token connectors
 * based on user secrets that match api-token required secret names.
 */
export async function listConnectors(
  orgId: string,
  userId: string,
): Promise<ConnectorResponse[]> {
  const db = globalThis.services.db;

  // Query OAuth connectors from DB, user secret names, and variable names in parallel
  const [dbResult, userSecretRows, userVariableRows] = await Promise.all([
    db
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
      .where(and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)))
      .orderBy(connectors.type),
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

  const dbConnectors: ConnectorResponse[] = dbResult.map((row) => ({
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

  // Derive api-token connected types from user secrets and variables
  const userSecretNames = new Set(userSecretRows.map((r) => r.name));
  const userVariableNames = new Set(userVariableRows.map((r) => r.name));
  const derivedTypes = deriveApiTokenConnectedTypes(
    userSecretNames,
    userVariableNames,
  );

  // DB record takes precedence over derived
  const dbTypeSet = new Set(dbConnectors.map((c) => c.type));
  const now = new Date().toISOString();
  const derivedConnectors: ConnectorResponse[] = derivedTypes
    .filter((type) => !dbTypeSet.has(type))
    .map((type) => ({
      id: null,
      type,
      authMethod: "api-token",
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      createdAt: now,
      updatedAt: now,
    }));

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

  const userSecretNames = new Set(userSecretRows.map((r) => r.name));
  const userVariableNames = new Set(userVariableRows.map((r) => r.name));
  const secretsOk = fields.secrets.every((name) => userSecretNames.has(name));
  const variablesOk = fields.variables.every((name) =>
    userVariableNames.has(name),
  );
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
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        eq(connectors.type, type),
      ),
    )
    .limit(1);

  const isUpdate = existingConnector.length > 0;

  // Upsert access token secret
  await upsertSecretByScope(
    orgId,
    scopeId,
    userId,
    secretName,
    accessToken,
    "connector",
    `OAuth token for ${type} connector`,
  );

  // Upsert refresh token secret if provided
  if (options?.refreshToken && options.refreshSecretName) {
    await upsertSecretByScope(
      orgId,
      scopeId,
      userId,
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
        userId,
        type,
        authMethod: "oauth",
        externalId: userInfo.id,
        externalUsername: userInfo.username,
        externalEmail: userInfo.email,
        oauthScopes: JSON.stringify(oauthScopes),
        tokenExpiresAt,
        orgId,
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
    // OAuth connector: delete DB record + connector-type secrets
    await db.delete(connectors).where(eq(connectors.id, existing.id));

    const secretNames: string[] = [];
    const config = CONNECTOR_TYPES[type];
    const authMethodConfig = config.authMethods[existing.authMethod];
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
 * Create or update a connector secret (e.g., refresh token)
 */
export async function upsertConnectorSecret(
  orgId: string,
  scopeId: string | null,
  userId: string,
  secretName: string,
  secretValue: string,
): Promise<void> {
  await upsertSecretByScope(
    orgId,
    scopeId,
    userId,
    secretName,
    secretValue,
    "connector",
    `Connector secret: ${secretName}`,
  );
}
