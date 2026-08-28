import { command } from "ccstate";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { and, asc, eq, inArray, lte } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { type Db, writeDb$ } from "../external/db";

const DELETE_BATCH_SIZE = 1000;
const TEST_DELETE_BATCH_SIZE = 1;
const MAX_BATCHES = 10;

interface ConnectorOauthStateCleanupOwner {
  readonly userId: string;
  readonly orgId: string;
}

async function cleanupConnectorOauthStates(
  db: Db,
  cutoff: Date,
  owner: ConnectorOauthStateCleanupOwner | undefined,
  batchSize: number,
  signal: AbortSignal,
): Promise<number> {
  const expiredWhere = owner
    ? and(
        lte(connectorOauthStates.expiresAt, cutoff),
        eq(connectorOauthStates.userId, owner.userId),
        eq(connectorOauthStates.orgId, owner.orgId),
      )
    : lte(connectorOauthStates.expiresAt, cutoff);
  let totalDeleted = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const expiredStates = db
      .select({ id: connectorOauthStates.id })
      .from(connectorOauthStates)
      .where(expiredWhere)
      .orderBy(asc(connectorOauthStates.expiresAt))
      .limit(batchSize);
    const { rowCount } = await db
      .delete(connectorOauthStates)
      .where(inArray(connectorOauthStates.id, expiredStates));
    signal.throwIfAborted();

    const batchDeleted = rowCount ?? 0;
    totalDeleted += batchDeleted;
    if (batchDeleted < batchSize) {
      break;
    }
  }

  return totalDeleted;
}

export const cleanupConnectorOauthStates$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    return await cleanupConnectorOauthStates(
      set(writeDb$),
      nowDate(),
      undefined,
      DELETE_BATCH_SIZE,
      signal,
    );
  },
);

export const cleanupConnectorOauthStatesForTest$ = command(
  async ({ set }, marker: string, signal: AbortSignal): Promise<number> => {
    return await cleanupConnectorOauthStates(
      set(writeDb$),
      nowDate(),
      { userId: marker, orgId: marker },
      TEST_DELETE_BATCH_SIZE,
      signal,
    );
  },
);
