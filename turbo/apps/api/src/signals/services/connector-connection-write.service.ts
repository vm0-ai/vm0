import { connectors } from "@vm0/db/schema/connector";
import { isNotNull, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { deleteConnectorOwnedCredentialRows } from "./connector-credential-storage-write.service";

export interface StoredConnectorConnectionRow {
  readonly id: string;
  readonly authMethod: string;
  readonly externalId: string | null;
  readonly externalUsername: string | null;
  readonly externalEmail: string | null;
  readonly oauthScopes: string | null;
  readonly needsReconnect: boolean;
  readonly reconnectReason: string | null;
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type ConnectorConnectionTarget =
  | {
      readonly kind: "builtin";
      readonly connectorSlug: string;
      readonly identity:
        | { readonly kind: "local" }
        | {
            readonly kind: "external";
            readonly externalId: string;
            readonly externalUsername: string | null;
            readonly externalEmail: string | null;
            readonly oauthScopes: readonly string[];
          };
    }
  | {
      readonly kind: "custom";
      readonly customConnectorId: string;
    };

interface ConnectorCredentialWriteContext {
  readonly db: Tx;
  readonly connectorId: string;
}

interface ReplaceConnectorConnectionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly authMethod: string;
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly target: ConnectorConnectionTarget;
  readonly writeCredentials: (
    context: ConnectorCredentialWriteContext,
    signal: AbortSignal,
  ) => Promise<void>;
}

function connectorConnectionSelection() {
  return {
    id: connectors.id,
    authMethod: connectors.authMethod,
    externalId: connectors.externalId,
    externalUsername: connectors.externalUsername,
    externalEmail: connectors.externalEmail,
    oauthScopes: connectors.oauthScopes,
    needsReconnect: connectors.needsReconnect,
    reconnectReason: connectors.reconnectReason,
    storageVersion: connectors.storageVersion,
    tokenExpiresAt: connectors.tokenExpiresAt,
    createdAt: connectors.createdAt,
    updatedAt: connectors.updatedAt,
  };
}

async function upsertConnectorConnection(
  db: Tx,
  args: Omit<ReplaceConnectorConnectionArgs, "writeCredentials">,
): Promise<StoredConnectorConnectionRow> {
  const identityValues =
    args.target.kind === "builtin" && args.target.identity.kind === "external"
      ? {
          externalId: args.target.identity.externalId,
          externalUsername: args.target.identity.externalUsername,
          externalEmail: args.target.identity.externalEmail,
          oauthScopes: JSON.stringify(args.target.identity.oauthScopes),
        }
      : {
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
        };
  const targetValues =
    args.target.kind === "builtin"
      ? {
          connectorSlug: args.target.connectorSlug,
          customConnectorId: null,
        }
      : {
          connectorSlug: null,
          customConnectorId: args.target.customConnectorId,
        };
  const replacementValues = {
    authMethod: args.authMethod,
    storageVersion: args.storageVersion,
    ...identityValues,
    tokenExpiresAt: args.tokenExpiresAt,
    needsReconnect: false,
    reconnectReason: null,
  };
  const conflictTarget =
    args.target.kind === "builtin"
      ? [connectors.orgId, connectors.userId, connectors.connectorSlug]
      : [connectors.orgId, connectors.userId, connectors.customConnectorId];
  const conflictTargetWhere =
    args.target.kind === "builtin"
      ? isNotNull(connectors.connectorSlug)
      : isNotNull(connectors.customConnectorId);

  const [row] = await db
    .insert(connectors)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      ...targetValues,
      ...replacementValues,
    })
    .onConflictDoUpdate({
      target: conflictTarget,
      targetWhere: conflictTargetWhere,
      set: {
        ...replacementValues,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning(connectorConnectionSelection());
  if (!row) {
    throw new Error(
      `Failed to upsert ${args.target.kind === "builtin" ? "Builtin" : "Custom"} connector connection`,
    );
  }
  return row;
}

export async function replaceConnectorConnection(
  db: Tx,
  args: ReplaceConnectorConnectionArgs,
  signal: AbortSignal,
): Promise<StoredConnectorConnectionRow> {
  const connection = await upsertConnectorConnection(db, args);
  signal.throwIfAborted();

  await deleteConnectorOwnedCredentialRows(
    db,
    { connectorId: connection.id },
    signal,
  );
  await args.writeCredentials({ db, connectorId: connection.id }, signal);
  signal.throwIfAborted();

  return connection;
}
