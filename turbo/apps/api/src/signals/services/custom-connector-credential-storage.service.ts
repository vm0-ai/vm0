import { and, eq } from "drizzle-orm";
import { connectors } from "@vm0/db/schema/connector";

import type { Db } from "../external/db";
import {
  deleteConnectorCredentialStorageConnection,
  type ConnectorCredentialStorageDeclaration,
  upsertConnectorOwnedSecret,
  upsertConnectorOwnedVariable,
} from "./connector-credential-storage-write.service";

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
    readonly fields: readonly CustomConnectorCredentialField[];
    readonly orgId: string;
    readonly userId: string;
    readonly values: readonly PreparedCustomConnectorValue[];
  },
  signal: AbortSignal,
): Promise<void> {
  const storage = customConnectorStorageDeclaration(args.fields);
  for (const value of args.values) {
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

export async function deleteCustomConnectorMemberConnection(
  db: Db,
  args: CustomConnectorMemberConnection,
  signal: AbortSignal,
): Promise<void> {
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
