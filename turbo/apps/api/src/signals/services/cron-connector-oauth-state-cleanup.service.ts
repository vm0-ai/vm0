import { command } from "ccstate";
import { sql } from "drizzle-orm";

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
      const { rowCount } = await db.execute(sql`
        DELETE FROM connector_oauth_states
        WHERE id IN (
          SELECT id
          FROM connector_oauth_states
          WHERE expires_at <= ${cutoff}
          ORDER BY expires_at
          LIMIT ${DELETE_BATCH_SIZE}
        )
      `);
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
