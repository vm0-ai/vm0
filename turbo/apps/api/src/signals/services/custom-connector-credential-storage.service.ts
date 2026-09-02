import { and, eq } from "drizzle-orm";
import { connectors } from "@okouai/db/schema/connector";

import type { Db } from "../external/db";
import type { Tx } from "../../lib/db-types";
import {
  deleteConnectorCredentialStorageConnection,
  type ConnectorCredentialStorageDeclaration,
  upsertConnectorOwnedSecret,
  upsertConnectorOwnedVariable,
} from "./connector-credential-storage-write.service";
import { resolveConnectorAccount } from "./connector-account-resolution.service";
import { prepareConnectorAccountDeletion } from "./connector-account-lifecycle.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";

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
  db: Tx,
  args: CustomConnectorMemberConnection,
  signal: AbortSignal,
): Promise<"deleted" | "missing" | "ambiguous"> {
  await lockConnectorAccountTarget(db, {
    orgId: args.orgId,
    userId: args.userId,
    target: { kind: "custom", customConnectorId: args.connectorId },
  });
  signal.throwIfAborted();
  const resolution = await resolveConnectorAccount(db, {
    orgId: args.orgId,
    userId: args.userId,
    request: {
      target: { kind: "custom", customConnectorId: args.connectorId },
      selection: { kind: "target-only-client-singleton" },
    },
  });
  signal.throwIfAborted();
  if (resolution.kind === "ambiguous") {
    return "ambiguous";
  }
  if (resolution.kind !== "resolved") {
    return "missing";
  }
  await deleteCustomConnectorMemberConnectionById(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorId,
      memberConnectorId: resolution.account.connectorId,
    },
    signal,
  );
  return "deleted";
}

export async function deleteCustomConnectorMemberConnectionById(
  db: Db,
  args: CustomConnectorMemberConnection & {
    readonly memberConnectorId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [connection] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.customConnectorId, args.connectorId),
        eq(connectors.id, args.memberConnectorId),
        eq(connectors.userId, args.userId),
        eq(connectors.orgId, args.orgId),
      ),
    )
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (!connection) {
    return false;
  }
  await deleteConnectorCredentialStorageConnection(
    db,
    { connectorId: connection.id },
    signal,
  );
  return true;
}

export async function deleteCustomConnectorMemberConnectionExact(
  db: Tx,
  args: CustomConnectorMemberConnection & {
    readonly memberConnectorId: string;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "missing" }
  | {
      readonly kind: "deleted";
      readonly resolvedSelectionCount: number;
      readonly promotedDefaultConnectionId: string | null;
    }
> {
  const deletion = await prepareConnectorAccountDeletion(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "custom", customConnectorId: args.connectorId },
      connectionId: args.memberConnectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (deletion.kind !== "ready") {
    return deletion;
  }
  await deleteConnectorCredentialStorageConnection(
    db,
    { connectorId: args.memberConnectorId },
    signal,
  );
  return {
    kind: "deleted",
    resolvedSelectionCount: deletion.resolvedSelectionCount,
    promotedDefaultConnectionId: deletion.promotedDefaultConnectionId,
  };
}
