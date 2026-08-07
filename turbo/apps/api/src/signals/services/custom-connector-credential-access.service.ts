import { and, eq, inArray } from "drizzle-orm";
import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
} from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";

import type { ReadonlyDb } from "../external/db";

const LEGACY_SECRET_KEY = "secret";
const OAUTH_ACCESS_TOKEN_SECRET_NAME = "access_token";

interface CustomConnectorCredentialValueMarker {
  readonly connectorId: string;
  readonly kind: "secret" | "variable";
  readonly key: string;
}

interface CustomConnectorCredentialDefinition {
  readonly id: string;
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly storageVersion: number;
}

export type CustomConnectorCredentialAccess =
  | { readonly kind: "absent" }
  | {
      readonly kind: "current";
      readonly memberConnectorId: string;
    }
  | {
      readonly kind: "incompatible";
      readonly memberConnectorId: string;
      readonly expectedAuthMethod: OrgCustomConnectorAuthMode;
      readonly storedAuthMethod: string;
      readonly expectedStorageVersion: number;
      readonly storedStorageVersion: number;
    };

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

  const rows = await db
    .select({
      id: connectors.id,
      customConnectorId: connectors.customConnectorId,
      authMethod: connectors.authMethod,
      storageVersion: connectors.storageVersion,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        inArray(
          connectors.customConnectorId,
          args.definitions.map((definition) => {
            return definition.id;
          }),
        ),
      ),
    );
  const memberByConnectorId = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.customConnectorId) {
      memberByConnectorId.set(row.customConnectorId, row);
    }
  }

  const accesses = new Map<string, CustomConnectorCredentialAccess>();
  for (const definition of args.definitions) {
    const member = memberByConnectorId.get(definition.id);
    if (!member) {
      accesses.set(definition.id, { kind: "absent" });
    } else if (
      member.authMethod === definition.authMode &&
      member.storageVersion === definition.storageVersion
    ) {
      accesses.set(definition.id, {
        kind: "current",
        memberConnectorId: member.id,
      });
    } else {
      accesses.set(definition.id, {
        kind: "incompatible",
        memberConnectorId: member.id,
        expectedAuthMethod: definition.authMode,
        storedAuthMethod: member.authMethod,
        expectedStorageVersion: definition.storageVersion,
        storedStorageVersion: member.storageVersion,
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
  const valueRows = await db
    .select({
      connectorId: orgCustomConnectorValues.connectorId,
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
    );
  const legacyRows = await db
    .select({ connectorId: orgCustomConnectorSecrets.connectorId })
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
    );
  const markers: CustomConnectorCredentialValueMarker[] = valueRows.flatMap(
    (row) => {
      return row.kind === "secret" || row.kind === "variable"
        ? [
            {
              connectorId: row.connectorId,
              kind: row.kind,
              key: row.key,
            },
          ]
        : [];
    },
  );
  const markerKeys = new Set(
    markers.map((marker) => {
      return `${marker.connectorId}:${marker.kind}:${marker.key}`;
    }),
  );
  for (const row of legacyRows) {
    const markerKey = `${row.connectorId}:secret:${LEGACY_SECRET_KEY}`;
    if (!markerKeys.has(markerKey)) {
      markers.push({
        connectorId: row.connectorId,
        kind: "secret",
        key: LEGACY_SECRET_KEY,
      });
      markerKeys.add(markerKey);
    }
  }
  return markers;
}

export async function loadCurrentCustomConnectorOAuthConnectionIds(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
  },
): Promise<ReadonlySet<string>> {
  if (args.connectorIds?.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ customConnectorId: connectors.customConnectorId })
    .from(connectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
        eq(orgCustomConnectors.authMode, "oauth"),
        eq(connectors.authMethod, orgCustomConnectors.authMode),
        eq(connectors.storageVersion, orgCustomConnectors.storageVersion),
      ),
    )
    .innerJoin(
      secrets,
      and(
        eq(secrets.connectorId, connectors.id),
        eq(secrets.name, OAUTH_ACCESS_TOKEN_SECRET_NAME),
      ),
    )
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.needsReconnect, false),
        args.connectorIds
          ? inArray(connectors.customConnectorId, [...args.connectorIds])
          : undefined,
      ),
    );
  return new Set(
    rows.flatMap((row) => {
      return row.customConnectorId ? [row.customConnectorId] : [];
    }),
  );
}
