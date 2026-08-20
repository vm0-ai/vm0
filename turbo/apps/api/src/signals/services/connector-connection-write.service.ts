import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectors } from "@okouai/db/schema/connector";
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { deleteConnectorOwnedCredentialRows } from "./connector-credential-storage-write.service";
import type { ConnectorAccountMutation } from "./connector-account-mutation.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";

export interface StoredConnectorConnectionRow {
  readonly id: string;
  readonly authMethod: string;
  readonly displayName: string | null;
  readonly isDefault: boolean | null;
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

export interface ConnectorConnectionMetadataArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly authMethod: string;
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly target: ConnectorConnectionTarget;
}

interface ReplaceConnectorConnectionArgs extends ConnectorConnectionMetadataArgs {
  readonly resolution: ReadyConnectorConnectionMutation;
  readonly writeCredentials: (
    context: ConnectorCredentialWriteContext,
    signal: AbortSignal,
  ) => Promise<void>;
}

interface ExistingConnectorConnectionRow extends StoredConnectorConnectionRow {
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
}

export type ReadyConnectorConnectionMutation =
  | {
      readonly kind: "insert";
      readonly displayName: string | null;
    }
  | {
      readonly kind: "update";
      readonly existing: ExistingConnectorConnectionRow;
    };

export type ConnectorConnectionMutationResolution =
  | {
      readonly kind: "ready";
      readonly mutation: ReadyConnectorConnectionMutation;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "sibling-disabled" };

function connectorConnectionSelection() {
  return {
    id: connectors.id,
    authMethod: connectors.authMethod,
    displayName: connectors.displayName,
    isDefault: connectors.isDefault,
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

function existingConnectorConnectionSelection() {
  return {
    ...connectorConnectionSelection(),
    connectorSlug: connectors.connectorSlug,
    customConnectorId: connectors.customConnectorId,
  };
}

function targetCondition(target: ConnectorAccountTarget) {
  return target.kind === "builtin"
    ? eq(connectors.connectorSlug, target.connectorSlug)
    : eq(connectors.customConnectorId, target.customConnectorId);
}

export async function resolveConnectorConnectionMutation(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly mutation: ConnectorAccountMutation;
  },
): Promise<ConnectorConnectionMutationResolution> {
  await lockConnectorAccountTarget(db, args);

  if (args.mutation.intent === "reconnect") {
    const [existing] = await db
      .select(existingConnectorConnectionSelection())
      .from(connectors)
      .where(
        and(
          eq(connectors.id, args.mutation.connectionId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          targetCondition(args.target),
        ),
      )
      .for("update")
      .limit(1);
    return existing
      ? { kind: "ready", mutation: { kind: "update", existing } }
      : { kind: "missing" };
  }

  const existing = await db
    .select(existingConnectorConnectionSelection())
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        targetCondition(args.target),
      ),
    )
    .orderBy(connectors.id)
    .for("update")
    .limit(2);
  if (args.mutation.intent === "add") {
    return existing.length === 0
      ? {
          kind: "ready",
          mutation: {
            kind: "insert",
            displayName: args.mutation.displayName ?? null,
          },
        }
      : { kind: "sibling-disabled" };
  }
  if (existing.length > 1) {
    return { kind: "ambiguous" };
  }
  const [singleton] = existing;
  return singleton
    ? { kind: "ready", mutation: { kind: "update", existing: singleton } }
    : {
        kind: "ready",
        mutation: { kind: "insert", displayName: null },
      };
}

export async function writeConnectorConnectionMetadata(
  db: Tx,
  args: ConnectorConnectionMetadataArgs & {
    readonly resolution: ReadyConnectorConnectionMutation;
  },
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
  const [row] =
    args.resolution.kind === "insert"
      ? await db
          .insert(connectors)
          .values({
            orgId: args.orgId,
            userId: args.userId,
            displayName: args.resolution.displayName,
            isDefault: true,
            ...targetValues,
            ...replacementValues,
          })
          .returning(connectorConnectionSelection())
      : await db
          .update(connectors)
          .set({
            ...replacementValues,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(connectors.id, args.resolution.existing.id))
          .returning(connectorConnectionSelection());
  if (!row) {
    throw new Error(
      `Failed to write ${args.target.kind === "builtin" ? "Builtin" : "Custom"} connector connection`,
    );
  }
  return row;
}

export async function replaceConnectorConnection(
  db: Tx,
  args: ReplaceConnectorConnectionArgs,
  signal: AbortSignal,
): Promise<StoredConnectorConnectionRow> {
  const connection = await writeConnectorConnectionMetadata(db, args);
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
