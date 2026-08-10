import type { ConnectorAuthMethodRuntimeConfig } from "@vm0/connectors/connector-config";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { eq, isNotNull, sql, type SQL } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

interface ConnectorOwnedCredentialWrite {
  readonly connectorId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly name: string;
  readonly orgId: string;
  readonly userId: string;
}

interface ConnectorOwnedCredentialDescription {
  readonly description: string | null;
  readonly updatedDescription?: string | null;
}

export type ConnectorOwnerScope =
  | {
      readonly kind: "user";
      readonly userId: string;
    }
  | {
      readonly kind: "organization";
      readonly orgId: string;
    };

interface ConnectorOwnedCredentialDeleteConditions {
  readonly secret: SQL;
  readonly variable: SQL;
}

interface ConnectorCredentialStorageDeleteConditions extends ConnectorOwnedCredentialDeleteConditions {
  readonly connection: SQL;
}

export const connectorLocalConnectionState = {
  externalId: null,
  externalUsername: null,
  externalEmail: null,
  oauthScopes: null,
  tokenExpiresAt: null,
  needsReconnect: false,
  reconnectReason: null,
} as const;

function requireDeclaredStorageName(args: {
  readonly kind: "secret" | "variable";
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly name: string;
}): void {
  const names =
    args.kind === "secret"
      ? args.method.storage.secrets
      : args.method.storage.variables;
  if (!names.includes(args.name)) {
    throw new Error(
      `Connector auth method does not declare ${args.kind} ${args.name}`,
    );
  }
}

export async function upsertConnectorOwnedSecret(
  db: Db,
  args: ConnectorOwnedCredentialWrite &
    ConnectorOwnedCredentialDescription & {
      readonly encryptedValue: string;
    },
): Promise<void> {
  requireDeclaredStorageName({
    kind: "secret",
    method: args.method,
    name: args.name,
  });
  const [row] = await db
    .insert(secrets)
    .values({
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      encryptedValue: args.encryptedValue,
      description: args.description,
      type: "connector",
    })
    .onConflictDoUpdate({
      target: [secrets.connectorId, secrets.name],
      targetWhere: isNotNull(secrets.connectorId),
      set: {
        encryptedValue: args.encryptedValue,
        ...(args.updatedDescription === undefined
          ? {}
          : { description: args.updatedDescription }),
        updatedAt: nowDate(),
      },
    })
    .returning({ id: secrets.id });
  if (!row) {
    throw new Error(`Connector secret ${args.name} is owned by another row`);
  }
}

export async function upsertConnectorOwnedVariable(
  db: Db,
  args: ConnectorOwnedCredentialWrite &
    ConnectorOwnedCredentialDescription & {
      readonly value: string;
    },
): Promise<void> {
  requireDeclaredStorageName({
    kind: "variable",
    method: args.method,
    name: args.name,
  });
  const [row] = await db
    .insert(variables)
    .values({
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      value: args.value,
      description: args.description,
      type: "connector",
    })
    .onConflictDoUpdate({
      target: [
        variables.orgId,
        variables.userId,
        variables.type,
        variables.name,
      ],
      set: {
        connectorId: args.connectorId,
        value: args.value,
        ...(args.updatedDescription === undefined
          ? {}
          : { description: args.updatedDescription }),
        updatedAt: nowDate(),
      },
      setWhere: eq(variables.connectorId, args.connectorId),
    })
    .returning({ id: variables.id });
  if (!row) {
    throw new Error(`Connector variable ${args.name} is owned by another row`);
  }
}

async function deleteConnectorOwnedCredentialRowsWhere(
  db: Db,
  conditions: ConnectorOwnedCredentialDeleteConditions,
  signal: AbortSignal,
): Promise<void> {
  await db.delete(secrets).where(conditions.secret);
  signal.throwIfAborted();
  await db.delete(variables).where(conditions.variable);
  signal.throwIfAborted();
}

async function deleteConnectorCredentialStorageConnectionsWhere(
  db: Db,
  conditions: ConnectorCredentialStorageDeleteConditions,
  signal: AbortSignal,
): Promise<void> {
  await deleteConnectorOwnedCredentialRowsWhere(db, conditions, signal);
  await db.delete(connectors).where(conditions.connection);
  signal.throwIfAborted();
}

export async function deleteConnectorOwnedCredentialRows(
  db: Db,
  args: {
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await deleteConnectorOwnedCredentialRowsWhere(
    db,
    {
      secret: eq(secrets.connectorId, args.connectorId),
      variable: eq(variables.connectorId, args.connectorId),
    },
    signal,
  );
}

export async function deleteConnectorCredentialStorageConnection(
  db: Db,
  args: {
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await deleteConnectorCredentialStorageConnectionsWhere(
    db,
    {
      secret: eq(secrets.connectorId, args.connectorId),
      variable: eq(variables.connectorId, args.connectorId),
      connection: eq(connectors.id, args.connectorId),
    },
    signal,
  );
}

export async function deleteConnectorCredentialStorageConnectionsForOwner(
  db: Db,
  owner: ConnectorOwnerScope,
  signal: AbortSignal,
): Promise<void> {
  const conditions: ConnectorCredentialStorageDeleteConditions =
    owner.kind === "user"
      ? {
          secret: sql`${eq(secrets.userId, owner.userId)} AND ${isNotNull(secrets.connectorId)}`,
          variable: sql`${eq(variables.userId, owner.userId)} AND ${isNotNull(variables.connectorId)}`,
          connection: eq(connectors.userId, owner.userId),
        }
      : {
          secret: sql`${eq(secrets.orgId, owner.orgId)} AND ${isNotNull(secrets.connectorId)}`,
          variable: sql`${eq(variables.orgId, owner.orgId)} AND ${isNotNull(variables.connectorId)}`,
          connection: eq(connectors.orgId, owner.orgId),
        };
  await deleteConnectorCredentialStorageConnectionsWhere(
    db,
    conditions,
    signal,
  );
}
