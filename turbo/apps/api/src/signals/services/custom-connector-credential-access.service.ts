import { and, eq, inArray } from "drizzle-orm";
import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
} from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { alias } from "drizzle-orm/pg-core";

import { nowDate } from "../../lib/time";
import type { ReadonlyDb } from "../external/db";
import { connectorCredentialStatusForAccess } from "./connector-credential-status.service";

const LEGACY_SECRET_KEY = "secret";
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
  const [valueRows, legacyRows] = await Promise.all([
    db
      .select({
        connectorId: orgCustomConnectorValues.connectorId,
        authMode: orgCustomConnectors.authMode,
        storageVersion: orgCustomConnectors.storageVersion,
        kind: orgCustomConnectorValues.kind,
        key: orgCustomConnectorValues.key,
      })
      .from(orgCustomConnectorValues)
      .innerJoin(
        orgCustomConnectors,
        and(
          eq(orgCustomConnectors.id, orgCustomConnectorValues.connectorId),
          eq(orgCustomConnectors.orgId, orgCustomConnectorValues.orgId),
        ),
      )
      .innerJoin(
        connectors,
        and(
          eq(connectors.customConnectorId, orgCustomConnectors.id),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.authMethod, orgCustomConnectors.authMode),
          eq(connectors.storageVersion, orgCustomConnectors.storageVersion),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectorValues.orgId, args.orgId),
          eq(orgCustomConnectorValues.userId, args.userId),
          args.connectorIds
            ? inArray(orgCustomConnectorValues.connectorId, [
                ...args.connectorIds,
              ])
            : undefined,
        ),
      ),
    db
      .select({
        connectorId: orgCustomConnectorSecrets.connectorId,
        authMode: orgCustomConnectors.authMode,
        storageVersion: orgCustomConnectors.storageVersion,
      })
      .from(orgCustomConnectorSecrets)
      .innerJoin(
        orgCustomConnectors,
        and(
          eq(orgCustomConnectors.id, orgCustomConnectorSecrets.connectorId),
          eq(orgCustomConnectors.orgId, orgCustomConnectorSecrets.orgId),
          eq(orgCustomConnectors.authMode, "manual"),
        ),
      )
      .innerJoin(
        connectors,
        and(
          eq(connectors.customConnectorId, orgCustomConnectors.id),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.authMethod, orgCustomConnectors.authMode),
          eq(connectors.storageVersion, orgCustomConnectors.storageVersion),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectorSecrets.orgId, args.orgId),
          eq(orgCustomConnectorSecrets.userId, args.userId),
          args.connectorIds
            ? inArray(orgCustomConnectorSecrets.connectorId, [
                ...args.connectorIds,
              ])
            : undefined,
        ),
      ),
  ]);
  const markers: CustomConnectorCredentialValueMarker[] = valueRows.flatMap(
    (row) => {
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
  const markerKeys = new Set(
    markers.map((marker) => {
      return `${marker.connectorId}:${marker.authMode}:${marker.storageVersion}:${marker.kind}:${marker.key}`;
    }),
  );
  for (const row of legacyRows) {
    const markerKey = `${row.connectorId}:${row.authMode}:${row.storageVersion}:secret:${LEGACY_SECRET_KEY}`;
    if (!markerKeys.has(markerKey)) {
      markers.push({
        connectorId: row.connectorId,
        authMode: row.authMode,
        storageVersion: row.storageVersion,
        kind: "secret",
        key: LEGACY_SECRET_KEY,
      });
      markerKeys.add(markerKey);
    }
  }
  return markers;
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
