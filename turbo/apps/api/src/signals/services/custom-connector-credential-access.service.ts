import { and, eq, inArray, sql } from "drizzle-orm";
import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
} from "@okouai/db/schema/org-custom-connector";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import type { ReadonlyDb } from "../external/db";
import {
  connectorCredentialStatusForAccess,
  connectorRuntimeCredentialStatusForAccess,
} from "./connector-credential-status.service";

const OAUTH_ACCESS_TOKEN_SECRET_NAME = "access_token";
const OAUTH_REFRESH_TOKEN_SECRET_NAME = "refresh_token";
const customConnectorRuntimeStorageKindSchema = z.enum(["secret", "variable"]);
type CustomConnectorRuntimeStorageKind = z.output<
  typeof customConnectorRuntimeStorageKindSchema
>;
const customConnectorRuntimeStorageKindDecoder = zodEnumDriverValueDecoder(
  customConnectorRuntimeStorageKindSchema,
);

const customConnectorAccessTokenSecret = alias(
  secrets,
  "custom_connector_access_token_secret",
);
const customConnectorRefreshTokenSecret = alias(
  secrets,
  "custom_connector_refresh_token_secret",
);

export interface CustomConnectorCredentialValueMarker {
  readonly connectorId: string;
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly storageVersion: number;
  readonly kind: "secret" | "variable";
  readonly key: string;
}

export type CustomConnectorStoredValue =
  | {
      readonly connectorId: string;
      readonly kind: "secret";
      readonly key: string;
      readonly encryptedValue: string;
    }
  | {
      readonly connectorId: string;
      readonly kind: "variable";
      readonly key: string;
      readonly value: string;
    };

interface CustomConnectorCredentialDefinition {
  readonly id: string;
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly storageVersion: number;
}

interface CustomConnectorStoredConnection {
  readonly id: string;
  readonly updatedAt: Date;
  readonly customConnectorId: string;
  readonly storedAuthMethod: string;
  readonly storedStorageVersion: number;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly definitionAuthMethod: OrgCustomConnectorAuthMode;
  readonly definitionStorageVersion: number;
  readonly oauthAccessTokenId: string | null;
  readonly oauthRefreshTokenId: string | null;
}

interface ConnectedCustomConnectorConnection {
  readonly id: string;
  readonly updatedAt: Date;
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly storageVersion: number;
}

export type CustomConnectorCredentialAccess =
  | { readonly kind: "absent" }
  | {
      readonly kind: "current";
      readonly memberConnectorId: string;
      readonly runtimeAvailable: boolean;
    }
  | {
      readonly kind: "incompatible";
      readonly memberConnectorId: string;
      readonly expectedAuthMethod: OrgCustomConnectorAuthMode;
      readonly storedAuthMethod: string;
      readonly expectedStorageVersion: number;
      readonly storedStorageVersion: number;
      readonly definitionAuthMethod: OrgCustomConnectorAuthMode;
      readonly definitionStorageVersion: number;
    };

interface CustomConnectorRuntimeStorageSnapshot {
  readonly accesses: ReadonlyMap<string, CustomConnectorCredentialAccess>;
  readonly values: readonly CustomConnectorStoredValue[];
}

interface CustomConnectorRuntimeStorageRow extends CustomConnectorStoredConnection {
  readonly kind: CustomConnectorRuntimeStorageKind | null;
  readonly key: string | null;
  readonly storedValue: string | null;
}

function customConnectorStoredConnectionsQuery(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
    readonly memberConnectorIds?: readonly string[];
    readonly defaultOnly?: boolean;
  },
) {
  return db
    .select({
      id: sql`${connectors.id}`
        .mapWith(connectors.id)
        .as("member_connector_id"),
      updatedAt: connectors.updatedAt,
      customConnectorId: sql`${orgCustomConnectors.id}`
        .mapWith(orgCustomConnectors.id)
        .as("custom_connector_id"),
      storedAuthMethod: sql`${connectors.authMethod}`
        .mapWith(connectors.authMethod)
        .as("stored_auth_method"),
      storedStorageVersion: sql`${connectors.storageVersion}`
        .mapWith(connectors.storageVersion)
        .as("stored_storage_version"),
      storedNeedsReconnect: sql`${connectors.needsReconnect}`
        .mapWith(connectors.needsReconnect)
        .as("stored_needs_reconnect"),
      tokenExpiresAt: sql`${connectors.tokenExpiresAt}`
        .mapWith(connectors.tokenExpiresAt)
        .as("token_expires_at"),
      definitionAuthMethod: sql`${orgCustomConnectors.authMode}`
        .mapWith(orgCustomConnectors.authMode)
        .as("definition_auth_method"),
      definitionStorageVersion: sql`${orgCustomConnectors.storageVersion}`
        .mapWith(orgCustomConnectors.storageVersion)
        .as("definition_storage_version"),
      oauthAccessTokenId: sql`${customConnectorAccessTokenSecret.id}`
        .mapWith(customConnectorAccessTokenSecret.id)
        .as("oauth_access_token_id"),
      oauthRefreshTokenId: sql`${customConnectorRefreshTokenSecret.id}`
        .mapWith(customConnectorRefreshTokenSecret.id)
        .as("oauth_refresh_token_id"),
    })
    .from(connectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
      ),
    )
    .leftJoin(
      customConnectorAccessTokenSecret,
      and(
        eq(customConnectorAccessTokenSecret.connectorId, connectors.id),
        eq(
          customConnectorAccessTokenSecret.name,
          OAUTH_ACCESS_TOKEN_SECRET_NAME,
        ),
      ),
    )
    .leftJoin(
      customConnectorRefreshTokenSecret,
      and(
        eq(customConnectorRefreshTokenSecret.connectorId, connectors.id),
        eq(
          customConnectorRefreshTokenSecret.name,
          OAUTH_REFRESH_TOKEN_SECRET_NAME,
        ),
      ),
    )
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        args.defaultOnly ? eq(connectors.isDefault, true) : undefined,
        args.connectorIds
          ? inArray(connectors.customConnectorId, [...args.connectorIds])
          : undefined,
        args.memberConnectorIds
          ? inArray(connectors.id, [...args.memberConnectorIds])
          : undefined,
      ),
    );
}

async function loadCustomConnectorStoredConnections(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
  },
): Promise<readonly CustomConnectorStoredConnection[]> {
  if (args.connectorIds?.length === 0) {
    return [];
  }
  return await customConnectorStoredConnectionsQuery(db, {
    ...args,
    defaultOnly: true,
  });
}

function customConnectorStoredConnectionIsCurrent(
  connection: CustomConnectorStoredConnection,
): boolean {
  return (
    connection.storedAuthMethod === connection.definitionAuthMethod &&
    connection.storedStorageVersion === connection.definitionStorageVersion
  );
}

function customConnectorStoredConnectionIsConnected(
  connection: CustomConnectorStoredConnection,
  now: Date,
): boolean {
  if (!customConnectorStoredConnectionIsCurrent(connection)) {
    return false;
  }
  const credentialStatus = connectorCredentialStatusForAccess({
    storedNeedsReconnect: connection.storedNeedsReconnect,
    tokenExpiresAt:
      connection.definitionAuthMethod === "oauth"
        ? connection.tokenExpiresAt
        : null,
    now,
    isRefreshable: connection.oauthRefreshTokenId !== null,
  });
  return (
    credentialStatus === "available" &&
    (connection.definitionAuthMethod === "manual" ||
      connection.oauthAccessTokenId !== null)
  );
}

function currentCustomConnectorStoredConnectionIsRuntimeAvailable(
  connection: CustomConnectorStoredConnection,
  now: Date,
): boolean {
  return (
    connectorRuntimeCredentialStatusForAccess({
      storedNeedsReconnect: connection.storedNeedsReconnect,
      tokenExpiresAt:
        connection.definitionAuthMethod === "oauth"
          ? connection.tokenExpiresAt
          : null,
      now,
      isRefreshable: connection.definitionAuthMethod === "oauth",
    }) === "available"
  );
}

function customConnectorCredentialAccesses(
  definitions: readonly CustomConnectorCredentialDefinition[],
  rows: readonly CustomConnectorStoredConnection[],
  memberConnectorIdsByCustomConnectorId: ReadonlyMap<string, string>,
): ReadonlyMap<string, CustomConnectorCredentialAccess> {
  const memberById = new Map<string, CustomConnectorStoredConnection>();
  for (const row of rows) {
    memberById.set(row.id, row);
  }

  const accesses = new Map<string, CustomConnectorCredentialAccess>();
  const now = nowDate();
  for (const definition of definitions) {
    const memberConnectorId = memberConnectorIdsByCustomConnectorId.get(
      definition.id,
    );
    const member = memberConnectorId
      ? memberById.get(memberConnectorId)
      : undefined;
    if (!member || member.customConnectorId !== definition.id) {
      accesses.set(definition.id, { kind: "absent" });
    } else if (
      member.definitionAuthMethod === definition.authMode &&
      member.definitionStorageVersion === definition.storageVersion &&
      customConnectorStoredConnectionIsCurrent(member)
    ) {
      accesses.set(definition.id, {
        kind: "current",
        memberConnectorId: member.id,
        runtimeAvailable:
          currentCustomConnectorStoredConnectionIsRuntimeAvailable(member, now),
      });
    } else {
      accesses.set(definition.id, {
        kind: "incompatible",
        memberConnectorId: member.id,
        expectedAuthMethod: definition.authMode,
        storedAuthMethod: member.storedAuthMethod,
        expectedStorageVersion: definition.storageVersion,
        storedStorageVersion: member.storedStorageVersion,
        definitionAuthMethod: member.definitionAuthMethod,
        definitionStorageVersion: member.definitionStorageVersion,
      });
    }
  }
  return accesses;
}

function customConnectorRuntimeStorageSnapshot(
  definitions: readonly CustomConnectorCredentialDefinition[],
  rows: readonly CustomConnectorRuntimeStorageRow[],
  memberConnectorIdsByCustomConnectorId: ReadonlyMap<string, string>,
): CustomConnectorRuntimeStorageSnapshot {
  const connectionsById = new Map<string, CustomConnectorStoredConnection>();
  for (const row of rows) {
    connectionsById.set(row.id, row);
  }
  const accesses = customConnectorCredentialAccesses(
    definitions,
    [...connectionsById.values()],
    memberConnectorIdsByCustomConnectorId,
  );
  const expectedByMemberConnectorId = new Map(
    definitions.flatMap((definition) => {
      const access = accesses.get(definition.id);
      return access?.kind === "current"
        ? ([[access.memberConnectorId, definition]] as const)
        : [];
    }),
  );
  const values: CustomConnectorStoredValue[] = [];
  for (const row of rows) {
    const expected = expectedByMemberConnectorId.get(row.id);
    if (
      !expected ||
      row.kind === null ||
      row.customConnectorId !== expected.id ||
      row.definitionAuthMethod !== expected.authMode ||
      row.definitionStorageVersion !== expected.storageVersion
    ) {
      continue;
    }
    if (row.key === null || row.storedValue === null) {
      throw new Error("Expected a complete custom connector stored value row");
    }
    if (row.kind === "secret") {
      values.push({
        connectorId: row.customConnectorId,
        kind: "secret",
        key: row.key,
        encryptedValue: row.storedValue,
      });
    } else {
      values.push({
        connectorId: row.customConnectorId,
        kind: "variable",
        key: row.key,
        value: row.storedValue,
      });
    }
  }
  return { accesses, values };
}

export async function loadCurrentCustomConnectorValueMarkers(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
  },
): Promise<readonly CustomConnectorCredentialValueMarker[]> {
  if (args.connectorIds?.length === 0) {
    return [];
  }
  const secretQuery = db
    .select({
      connectorId: orgCustomConnectors.id,
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
      kind: sql`'secret'`.mapWith(pgTextDecoder).as("kind"),
      key: secrets.name,
    })
    .from(secrets)
    .innerJoin(
      connectors,
      and(
        eq(connectors.id, secrets.connectorId),
        eq(connectors.orgId, secrets.orgId),
        eq(connectors.userId, secrets.userId),
      ),
    )
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
        eq(orgCustomConnectors.authMode, connectors.authMethod),
        eq(orgCustomConnectors.storageVersion, connectors.storageVersion),
      ),
    )
    .where(
      and(
        eq(secrets.type, "connector"),
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(connectors.isDefault, true),
        args.connectorIds
          ? inArray(orgCustomConnectors.id, [...args.connectorIds])
          : undefined,
      ),
    );
  const variableQuery = db
    .select({
      connectorId: orgCustomConnectors.id,
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
      kind: sql`'variable'`.mapWith(pgTextDecoder).as("kind"),
      key: variables.name,
    })
    .from(variables)
    .innerJoin(
      connectors,
      and(
        eq(connectors.id, variables.connectorId),
        eq(connectors.orgId, variables.orgId),
        eq(connectors.userId, variables.userId),
      ),
    )
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
        eq(orgCustomConnectors.authMode, connectors.authMethod),
        eq(orgCustomConnectors.storageVersion, connectors.storageVersion),
      ),
    )
    .where(
      and(
        eq(variables.type, "connector"),
        eq(variables.orgId, args.orgId),
        eq(variables.userId, args.userId),
        eq(connectors.isDefault, true),
        args.connectorIds
          ? inArray(orgCustomConnectors.id, [...args.connectorIds])
          : undefined,
      ),
    );
  const rows = await secretQuery.unionAll(variableQuery);
  return rows.flatMap(
    (row): readonly CustomConnectorCredentialValueMarker[] => {
      return row.kind === "secret" || row.kind === "variable"
        ? [
            {
              connectorId: row.connectorId,
              authMode: row.authMode,
              storageVersion: row.storageVersion,
              kind: row.kind,
              key: row.key,
            },
          ]
        : [];
    },
  );
}

export async function loadCurrentCustomConnectorStoredValues(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitions: readonly CustomConnectorCredentialDefinition[];
    readonly memberConnectorIdsByCustomConnectorId: ReadonlyMap<string, string>;
  },
): Promise<CustomConnectorRuntimeStorageSnapshot> {
  if (args.definitions.length === 0) {
    return { accesses: new Map(), values: [] };
  }

  const connectorIds = args.definitions.map((definition) => {
    return definition.id;
  });
  const memberConnectorIds = args.definitions.flatMap((definition) => {
    const memberConnectorId = args.memberConnectorIdsByCustomConnectorId.get(
      definition.id,
    );
    return memberConnectorId ? [memberConnectorId] : [];
  });
  if (memberConnectorIds.length === 0) {
    return customConnectorRuntimeStorageSnapshot(
      args.definitions,
      [],
      args.memberConnectorIdsByCustomConnectorId,
    );
  }
  const storedConnections = db.$with("custom_connector_runtime_connections").as(
    customConnectorStoredConnectionsQuery(db, {
      orgId: args.orgId,
      userId: args.userId,
      connectorIds,
      memberConnectorIds,
    }),
  );
  const secretQuery = db
    .select({
      memberConnectorId: sql`${storedConnections.id}`
        .mapWith(pgTextDecoder)
        .as("value_member_connector_id"),
      kind: sql`'secret'`
        .mapWith(customConnectorRuntimeStorageKindDecoder)
        .as("kind"),
      key: secrets.name,
      storedValue: secrets.encryptedValue,
    })
    .from(storedConnections)
    .innerJoin(secrets, eq(secrets.connectorId, storedConnections.id))
    .where(
      and(
        eq(secrets.type, "connector"),
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(
          storedConnections.storedAuthMethod,
          storedConnections.definitionAuthMethod,
        ),
        eq(
          storedConnections.storedStorageVersion,
          storedConnections.definitionStorageVersion,
        ),
      ),
    );
  const variableQuery = db
    .select({
      memberConnectorId: sql`${storedConnections.id}`
        .mapWith(pgTextDecoder)
        .as("value_member_connector_id"),
      kind: sql`'variable'`
        .mapWith(customConnectorRuntimeStorageKindDecoder)
        .as("kind"),
      key: variables.name,
      storedValue: variables.value,
    })
    .from(storedConnections)
    .innerJoin(variables, eq(variables.connectorId, storedConnections.id))
    .where(
      and(
        eq(variables.type, "connector"),
        eq(variables.orgId, args.orgId),
        eq(variables.userId, args.userId),
        eq(
          storedConnections.storedAuthMethod,
          storedConnections.definitionAuthMethod,
        ),
        eq(
          storedConnections.storedStorageVersion,
          storedConnections.definitionStorageVersion,
        ),
      ),
    );
  const storedValues = db
    .$with("custom_connector_runtime_values")
    .as(unionAll(secretQuery, variableQuery));
  const rows = await db
    .with(storedConnections, storedValues)
    .select({
      id: storedConnections.id,
      updatedAt: storedConnections.updatedAt,
      customConnectorId: storedConnections.customConnectorId,
      storedAuthMethod: storedConnections.storedAuthMethod,
      storedStorageVersion: storedConnections.storedStorageVersion,
      storedNeedsReconnect: storedConnections.storedNeedsReconnect,
      tokenExpiresAt: storedConnections.tokenExpiresAt,
      definitionAuthMethod: storedConnections.definitionAuthMethod,
      definitionStorageVersion: storedConnections.definitionStorageVersion,
      oauthAccessTokenId: storedConnections.oauthAccessTokenId,
      oauthRefreshTokenId: storedConnections.oauthRefreshTokenId,
      kind: storedValues.kind,
      key: storedValues.key,
      storedValue: storedValues.storedValue,
    })
    .from(storedConnections)
    .leftJoin(
      storedValues,
      eq(storedValues.memberConnectorId, storedConnections.id),
    );
  return customConnectorRuntimeStorageSnapshot(
    args.definitions,
    rows,
    args.memberConnectorIdsByCustomConnectorId,
  );
}

export async function loadConnectedCustomConnectorConnections(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
  },
): Promise<ReadonlyMap<string, ConnectedCustomConnectorConnection>> {
  if (args.connectorIds?.length === 0) {
    return new Map();
  }
  const rows = await loadCustomConnectorStoredConnections(db, args);
  const now = nowDate();
  const connectedConnections = new Map<
    string,
    ConnectedCustomConnectorConnection
  >();
  for (const row of rows) {
    if (customConnectorStoredConnectionIsConnected(row, now)) {
      connectedConnections.set(row.customConnectorId, {
        id: row.id,
        updatedAt: row.updatedAt,
        authMode: row.definitionAuthMethod,
        storageVersion: row.definitionStorageVersion,
      });
    }
  }
  return connectedConnections;
}

export function customConnectorDefinitionConnectedAccountId(args: {
  readonly connectedConnections: ReadonlyMap<
    string,
    ConnectedCustomConnectorConnection
  >;
  readonly definition: CustomConnectorCredentialDefinition;
}): string | null {
  const connection = args.connectedConnections.get(args.definition.id);
  const current =
    connection?.authMode === args.definition.authMode &&
    connection.storageVersion === args.definition.storageVersion;
  return current ? connection.id : null;
}

export function customConnectorDefinitionConnectedAccountUpdatedAt(args: {
  readonly connectedConnections: ReadonlyMap<
    string,
    ConnectedCustomConnectorConnection
  >;
  readonly definition: CustomConnectorCredentialDefinition;
}): Date | null {
  const connection = args.connectedConnections.get(args.definition.id);
  const current =
    connection?.authMode === args.definition.authMode &&
    connection.storageVersion === args.definition.storageVersion;
  return current ? connection.updatedAt : null;
}
