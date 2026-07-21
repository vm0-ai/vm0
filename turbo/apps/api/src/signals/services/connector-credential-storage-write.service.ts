import type { ConnectorAuthMethodRuntimeConfig } from "@vm0/connectors/connectors";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { eq } from "drizzle-orm";

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
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        connectorId: args.connectorId,
        encryptedValue: args.encryptedValue,
        ...(args.updatedDescription === undefined
          ? {}
          : { description: args.updatedDescription }),
        updatedAt: nowDate(),
      },
      setWhere: eq(secrets.connectorId, args.connectorId),
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
