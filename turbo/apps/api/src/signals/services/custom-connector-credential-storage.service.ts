import { and, eq, sql, type SQL } from "drizzle-orm";
import { connectors } from "@vm0/db/schema/connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";

import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  deleteConnectorCredentialStorageConnection,
  type ConnectorOwnerScope,
  type ConnectorCredentialStorageDeclaration,
  upsertConnectorOwnedSecret,
  upsertConnectorOwnedVariable,
} from "./connector-credential-storage-write.service";

const LEGACY_SECRET_KEY = "secret";

export type PreparedCustomConnectorValue =
  | {
      readonly kind: "secret";
      readonly key: string;
      readonly encryptedValue: string;
    }
  | {
      readonly kind: "variable";
      readonly key: string;
      readonly value: string;
      readonly encryptedValue: string;
    };

interface CustomConnectorCredentialField {
  readonly kind: "secret" | "variable";
  readonly key: string;
}

interface CustomConnectorMemberConnection {
  readonly connectorId: string;
  readonly orgId: string;
  readonly userId: string;
}

interface CustomConnectorStoredValueDeleteConditions {
  readonly legacySecret: SQL;
  readonly value: SQL;
}

function customConnectorStorageDeclaration(
  fields: readonly CustomConnectorCredentialField[],
): ConnectorCredentialStorageDeclaration {
  return {
    secrets: fields.flatMap((field) => {
      return field.kind === "secret" ? [field.key] : [];
    }),
    variables: fields.flatMap((field) => {
      return field.kind === "variable" ? [field.key] : [];
    }),
  };
}

export async function upsertCustomConnectorStoredValues(
  db: Db,
  args: {
    readonly connectionId: string;
    readonly customConnectorId: string;
    readonly fields: readonly CustomConnectorCredentialField[];
    readonly orgId: string;
    readonly syncLegacySecret: boolean;
    readonly userId: string;
    readonly values: readonly PreparedCustomConnectorValue[];
  },
  signal: AbortSignal,
): Promise<void> {
  const storage = customConnectorStorageDeclaration(args.fields);
  for (const value of args.values) {
    await db
      .insert(orgCustomConnectorValues)
      .values({
        connectorId: args.customConnectorId,
        userId: args.userId,
        orgId: args.orgId,
        kind: value.kind,
        key: value.key,
        encryptedValue: value.encryptedValue,
      })
      .onConflictDoUpdate({
        target: [
          orgCustomConnectorValues.connectorId,
          orgCustomConnectorValues.userId,
          orgCustomConnectorValues.kind,
          orgCustomConnectorValues.key,
        ],
        set: { encryptedValue: value.encryptedValue, updatedAt: nowDate() },
      });
    signal.throwIfAborted();

    if (
      args.syncLegacySecret &&
      value.kind === "secret" &&
      value.key === LEGACY_SECRET_KEY
    ) {
      await db
        .insert(orgCustomConnectorSecrets)
        .values({
          connectorId: args.customConnectorId,
          userId: args.userId,
          orgId: args.orgId,
          encryptedValue: value.encryptedValue,
        })
        .onConflictDoUpdate({
          target: [
            orgCustomConnectorSecrets.connectorId,
            orgCustomConnectorSecrets.userId,
          ],
          set: { encryptedValue: value.encryptedValue, updatedAt: nowDate() },
        });
      signal.throwIfAborted();
    }

    if (value.kind === "secret") {
      await upsertConnectorOwnedSecret(db, {
        connectorId: args.connectionId,
        storage,
        orgId: args.orgId,
        userId: args.userId,
        name: value.key,
        encryptedValue: value.encryptedValue,
        description: null,
        updatedDescription: null,
      });
    } else {
      await upsertConnectorOwnedVariable(db, {
        connectorId: args.connectionId,
        storage,
        orgId: args.orgId,
        userId: args.userId,
        name: value.key,
        value: value.value,
        description: null,
        updatedDescription: null,
      });
    }
    signal.throwIfAborted();
  }
}

async function deleteCustomConnectorStoredValuesWhere(
  db: Db,
  conditions: CustomConnectorStoredValueDeleteConditions,
  signal: AbortSignal,
): Promise<void> {
  await db.delete(orgCustomConnectorValues).where(conditions.value);
  signal.throwIfAborted();
  await db.delete(orgCustomConnectorSecrets).where(conditions.legacySecret);
  signal.throwIfAborted();
}

export async function deleteCustomConnectorStoredValues(
  db: Db,
  args: CustomConnectorMemberConnection,
  signal: AbortSignal,
): Promise<void> {
  await deleteCustomConnectorStoredValuesWhere(
    db,
    {
      value: sql`${eq(orgCustomConnectorValues.connectorId, args.connectorId)} AND ${eq(orgCustomConnectorValues.userId, args.userId)} AND ${eq(orgCustomConnectorValues.orgId, args.orgId)}`,
      legacySecret: sql`${eq(orgCustomConnectorSecrets.connectorId, args.connectorId)} AND ${eq(orgCustomConnectorSecrets.userId, args.userId)} AND ${eq(orgCustomConnectorSecrets.orgId, args.orgId)}`,
    },
    signal,
  );
}

export async function deleteCustomConnectorStoredValuesForOwner(
  db: Db,
  owner: ConnectorOwnerScope,
  signal: AbortSignal,
): Promise<void> {
  const conditions: CustomConnectorStoredValueDeleteConditions =
    owner.kind === "user"
      ? {
          value: eq(orgCustomConnectorValues.userId, owner.userId),
          legacySecret: eq(orgCustomConnectorSecrets.userId, owner.userId),
        }
      : {
          value: eq(orgCustomConnectorValues.orgId, owner.orgId),
          legacySecret: eq(orgCustomConnectorSecrets.orgId, owner.orgId),
        };
  await deleteCustomConnectorStoredValuesWhere(db, conditions, signal);
}

export async function deleteCustomConnectorMemberConnection(
  db: Db,
  args: CustomConnectorMemberConnection,
  signal: AbortSignal,
): Promise<void> {
  await deleteCustomConnectorStoredValues(db, args, signal);
  const [connection] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.customConnectorId, args.connectorId),
        eq(connectors.userId, args.userId),
        eq(connectors.orgId, args.orgId),
      ),
    )
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (!connection) {
    return;
  }
  await deleteConnectorCredentialStorageConnection(
    db,
    { connectorId: connection.id },
    signal,
  );
}
