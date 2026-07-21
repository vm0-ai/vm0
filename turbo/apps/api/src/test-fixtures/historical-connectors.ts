import { connectors } from "@vm0/db/schema/connector";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../lib/db";

const UNSUPPORTED_CONNECTOR_TYPES = [
  "removed-connector",
  "github",
  "gitlab",
] as const;

interface HistoricalConnectorFixture {
  readonly orgId: string;
  readonly userId: string;
}

/**
 * Seeds connector identities accepted by older registries but rejected by the
 * current product API. This is the narrow test-boundary exception for testing
 * reads of persisted connector identities that production APIs cannot create.
 */
export async function seedUnsupportedHistoricalConnectors(
  fixture: HistoricalConnectorFixture,
): Promise<void> {
  await db()
    .insert(connectors)
    .values([
      {
        type: "removed-connector",
        authMethod: "api-token",
        storageVersion: 1,
        userId: fixture.userId,
        orgId: fixture.orgId,
      },
      {
        type: "github",
        authMethod: "removed-auth-method",
        storageVersion: 1,
        userId: fixture.userId,
        orgId: fixture.orgId,
      },
      {
        type: "gitlab",
        authMethod: "oauth",
        storageVersion: 1,
        userId: fixture.userId,
        orgId: fixture.orgId,
      },
    ]);
}

/** Deletes only the unsupported connector identities seeded above. */
export async function deleteUnsupportedHistoricalConnectors(
  fixture: HistoricalConnectorFixture,
): Promise<void> {
  await db()
    .delete(connectors)
    .where(
      and(
        eq(connectors.orgId, fixture.orgId),
        eq(connectors.userId, fixture.userId),
        inArray(connectors.type, UNSUPPORTED_CONNECTOR_TYPES),
      ),
    );
}
