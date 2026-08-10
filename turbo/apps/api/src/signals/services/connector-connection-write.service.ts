import { connectors } from "@vm0/db/schema/connector";
import { isNotNull, sql } from "drizzle-orm";

import type { Db } from "../external/db";
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
      readonly externalId: string;
      readonly externalUsername: string | null;
      readonly externalEmail: string | null;
      readonly oauthScopes: readonly string[];
    }
  | {
      readonly kind: "custom";
      readonly customConnectorId: string;
    };

interface ConnectorCredentialWriteContext {
  readonly db: Db;
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
  db: Db,
  args: Omit<ReplaceConnectorConnectionArgs, "writeCredentials">,
): Promise<StoredConnectorConnectionRow> {
  if (args.target.kind === "builtin") {
    const [row] = await db
      .insert(connectors)
      .values({
        userId: args.userId,
        connectorSlug: args.target.connectorSlug,
        authMethod: args.authMethod,
        storageVersion: args.storageVersion,
        externalId: args.target.externalId,
        externalUsername: args.target.externalUsername,
        externalEmail: args.target.externalEmail,
        oauthScopes: JSON.stringify(args.target.oauthScopes),
        tokenExpiresAt: args.tokenExpiresAt,
        needsReconnect: false,
        reconnectReason: null,
        orgId: args.orgId,
      })
      .onConflictDoUpdate({
        target: [connectors.orgId, connectors.userId, connectors.connectorSlug],
        targetWhere: isNotNull(connectors.connectorSlug),
        set: {
          authMethod: args.authMethod,
          storageVersion: args.storageVersion,
          externalId: args.target.externalId,
          externalUsername: args.target.externalUsername,
          externalEmail: args.target.externalEmail,
          oauthScopes: JSON.stringify(args.target.oauthScopes),
          tokenExpiresAt: args.tokenExpiresAt,
          needsReconnect: false,
          reconnectReason: null,
          updatedAt: sql`clock_timestamp()`,
        },
      })
      .returning(connectorConnectionSelection());
    if (!row) {
      throw new Error("Failed to upsert Builtin connector connection");
    }
    return row;
  }

  const [row] = await db
    .insert(connectors)
    .values({
      customConnectorId: args.target.customConnectorId,
      authMethod: args.authMethod,
      storageVersion: args.storageVersion,
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      tokenExpiresAt: args.tokenExpiresAt,
      needsReconnect: false,
      reconnectReason: null,
      userId: args.userId,
      orgId: args.orgId,
    })
    .onConflictDoUpdate({
      target: [
        connectors.orgId,
        connectors.userId,
        connectors.customConnectorId,
      ],
      targetWhere: isNotNull(connectors.customConnectorId),
      set: {
        authMethod: args.authMethod,
        storageVersion: args.storageVersion,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        tokenExpiresAt: args.tokenExpiresAt,
        needsReconnect: false,
        reconnectReason: null,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning(connectorConnectionSelection());
  if (!row) {
    throw new Error("Failed to upsert Custom connector connection");
  }
  return row;
}

export async function replaceConnectorConnection(
  db: Db,
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
