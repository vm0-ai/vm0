import { and, eq } from "drizzle-orm";
import { connectors } from "@vm0/db/schema/connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@vm0/db/schema/org-custom-connector-value";

import type { Db } from "../external/db";
import { deleteConnectorCredentialStorageConnection } from "./connector-credential-storage-write.service";

interface CustomConnectorMemberConnection {
  readonly connectorId: string;
  readonly orgId: string;
  readonly userId: string;
}

export async function deleteCustomConnectorStoredValues(
  db: Db,
  args: CustomConnectorMemberConnection,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(orgCustomConnectorValues)
    .where(
      and(
        eq(orgCustomConnectorValues.connectorId, args.connectorId),
        eq(orgCustomConnectorValues.userId, args.userId),
        eq(orgCustomConnectorValues.orgId, args.orgId),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(orgCustomConnectorSecrets)
    .where(
      and(
        eq(orgCustomConnectorSecrets.connectorId, args.connectorId),
        eq(orgCustomConnectorSecrets.userId, args.userId),
        eq(orgCustomConnectorSecrets.orgId, args.orgId),
      ),
    );
  signal.throwIfAborted();
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
