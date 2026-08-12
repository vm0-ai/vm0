import { and, eq, inArray, sql } from "drizzle-orm";
import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
} from "@vm0/db/schema/org-custom-connector";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { alias } from "drizzle-orm/pg-core";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import type { ReadonlyDb } from "../external/db";
import { connectorCredentialStatusForAccess } from "./connector-credential-status.service";

const OAUTH_ACCESS_TOKEN_SECRET_NAME = "access_token";
const OAUTH_REFRESH_TOKEN_SECRET_NAME = "refresh_token";

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

interface UsableCustomConnectorConnection {
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly storageVersion: number;
}

export type CustomConnectorCredentialAccess =
  | { readonly kind: "absent" }
  | {
      readonly kind: "current";
      readonly memberConnectorId: string;
      readonly usable: boolean;
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
  return await db
    .select({
      id: connectors.id,
      customConnectorId: orgCustomConnectors.id,
      storedAuthMethod: connectors.authMethod,
      storedStorageVersion: connectors.storageVersion,
      storedNeedsReconnect: connectors.needsReconnect,
      tokenExpiresAt: connectors.tokenExpiresAt,
      definitionAuthMethod: orgCustomConnectors.authMode,
      definitionStorageVersion: orgCustomConnectors.storageVersion,
      oauthAccessTokenId: customConnectorAccessTokenSecret.id,
      oauthRefreshTokenId: customConnectorRefreshTokenSecret.id,
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
        args.connectorIds
          ? inArray(connectors.customConnectorId, [...args.connectorIds])
          : undefined,
      ),
    );
}

function customConnectorStoredConnectionIsCurrent(
  connection: CustomConnectorStoredConnection,
): boolean {
  return (
    connection.storedAuthMethod === connection.definitionAuthMethod &&
    connection.storedStorageVersion === connection.definitionStorageVersion
  );
}

function customConnectorStoredConnectionIsUsable(
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

export async function loadCustomConnectorCredentialAccesses(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitions: readonly CustomConnectorCredentialDefinition[];
  },
): Promise<ReadonlyMap<string, CustomConnectorCredentialAccess>> {
  if (args.definitions.length === 0) {
    return new Map();
  }

  const rows = await loadCustomConnectorStoredConnections(db, {
    orgId: args.orgId,
    userId: args.userId,
    connectorIds: args.definitions.map((definition) => {
      return definition.id;
    }),
  });
  const memberByConnectorId = new Map<
    string,
    CustomConnectorStoredConnection
  >();
  for (const row of rows) {
    memberByConnectorId.set(row.customConnectorId, row);
  }

  const accesses = new Map<string, CustomConnectorCredentialAccess>();
  const now = nowDate();
  for (const definition of args.definitions) {
    const member = memberByConnectorId.get(definition.id);
    if (!member) {
      accesses.set(definition.id, { kind: "absent" });
    } else if (
      member.definitionAuthMethod === definition.authMode &&
      member.definitionStorageVersion === definition.storageVersion &&
      customConnectorStoredConnectionIsCurrent(member)
    ) {
      accesses.set(definition.id, {
        kind: "current",
        memberConnectorId: member.id,
        usable: customConnectorStoredConnectionIsUsable(member, now),
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
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitions: readonly CustomConnectorCredentialDefinition[];
    readonly accesses: ReadonlyMap<string, CustomConnectorCredentialAccess>;
  },
): Promise<readonly CustomConnectorStoredValue[]> {
  const expectedByMemberConnectorId = new Map<
    string,
    CustomConnectorCredentialDefinition
  >();
  for (const definition of args.definitions) {
    const access = args.accesses.get(definition.id);
    if (access?.kind === "current") {
      expectedByMemberConnectorId.set(access.memberConnectorId, definition);
    }
  }
  const memberConnectorIds = [...expectedByMemberConnectorId.keys()];
  if (memberConnectorIds.length === 0) {
    return [];
  }

  const secretQuery = db
    .select({
      memberConnectorId: connectors.id,
      connectorId: orgCustomConnectors.id,
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
      kind: sql`'secret'`.mapWith(pgTextDecoder).as("kind"),
      key: secrets.name,
      storedValue: secrets.encryptedValue,
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
        inArray(connectors.id, memberConnectorIds),
      ),
    );
  const variableQuery = db
    .select({
      memberConnectorId: connectors.id,
      connectorId: orgCustomConnectors.id,
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
      kind: sql`'variable'`.mapWith(pgTextDecoder).as("kind"),
      key: variables.name,
      storedValue: variables.value,
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
        inArray(connectors.id, memberConnectorIds),
      ),
    );
  const rows = await secretQuery.unionAll(variableQuery);
  const values: CustomConnectorStoredValue[] = [];
  for (const row of rows) {
    const expected = expectedByMemberConnectorId.get(row.memberConnectorId);
    if (
      !expected ||
      row.connectorId !== expected.id ||
      row.authMode !== expected.authMode ||
      row.storageVersion !== expected.storageVersion
    ) {
      continue;
    }
    if (row.kind === "secret") {
      values.push({
        connectorId: row.connectorId,
        kind: "secret",
        key: row.key,
        encryptedValue: row.storedValue,
      });
    } else if (row.kind === "variable") {
      values.push({
        connectorId: row.connectorId,
        kind: "variable",
        key: row.key,
        value: row.storedValue,
      });
    } else {
      throw new Error("Invalid custom connector stored value kind");
    }
  }
  return values;
}

export async function loadUsableCustomConnectorConnections(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
  },
): Promise<ReadonlyMap<string, UsableCustomConnectorConnection>> {
  if (args.connectorIds?.length === 0) {
    return new Map();
  }
  const rows = await loadCustomConnectorStoredConnections(db, args);
  const now = nowDate();
  const usableConnections = new Map<string, UsableCustomConnectorConnection>();
  for (const row of rows) {
    if (customConnectorStoredConnectionIsUsable(row, now)) {
      usableConnections.set(row.customConnectorId, {
        authMode: row.definitionAuthMethod,
        storageVersion: row.definitionStorageVersion,
      });
    }
  }
  return usableConnections;
}

export function customConnectorDefinitionHasUsableConnection(args: {
  readonly usableConnections: ReadonlyMap<
    string,
    UsableCustomConnectorConnection
  >;
  readonly definition: CustomConnectorCredentialDefinition;
}): boolean {
  const connection = args.usableConnections.get(args.definition.id);
  return (
    connection?.authMode === args.definition.authMode &&
    connection.storageVersion === args.definition.storageVersion
  );
}
