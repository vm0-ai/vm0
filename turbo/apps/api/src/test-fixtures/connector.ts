import type { ConnectorRef } from "@vm0/api-contracts/contracts/connector-identity";
import { connectors } from "@vm0/db/schema/connector";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

export async function deleteConnectedConnectorFixture(values: {
  readonly connectorRef: ConnectorRef;
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  await createStore()
    .set(writeDb$)
    .delete(connectors)
    .where(
      and(
        eq(connectors.orgId, values.orgId),
        eq(connectors.userId, values.userId),
        eq(connectors.type, values.connectorRef),
      ),
    );
}
