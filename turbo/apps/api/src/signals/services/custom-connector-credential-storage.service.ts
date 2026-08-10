import { and, eq, sql, type SQL } from "drizzle-orm";
import { connectors } from "@vm0/db/schema/connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";

import type { Db } from "../external/db";
import {
  deleteConnectorCredentialStorageConnection,
  type ConnectorOwnerScope,
} from "./connector-credential-storage-write.service";

interface CustomConnectorMemberConnection {
  readonly connectorId: string;
  readonly orgId: string;
  readonly userId: string;
}

interface CustomConnectorStoredValueDeleteConditions {
  readonly legacySecret: SQL;
  readonly value: SQL;
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
