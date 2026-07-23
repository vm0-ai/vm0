import { command } from "ccstate";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { asc, inArray, lte } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const DELETE_BATCH_SIZE = 1000;
const MAX_BATCHES = 10;

export const cleanupConnectorOauthStates$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const cutoff = nowDate();
    let totalDeleted = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const expiredStates = db
        .select({ id: connectorOauthStates.id })
        .from(connectorOauthStates)
        .where(lte(connectorOauthStates.expiresAt, cutoff))
        .orderBy(asc(connectorOauthStates.expiresAt))
        .limit(DELETE_BATCH_SIZE);
      const { rowCount } = await db
        .delete(connectorOauthStates)
        .where(inArray(connectorOauthStates.id, expiredStates));
      signal.throwIfAborted();

      const batchDeleted = rowCount ?? 0;
      totalDeleted += batchDeleted;
      if (batchDeleted < DELETE_BATCH_SIZE) {
        break;
      }
    }

    return totalDeleted;
  },
);
