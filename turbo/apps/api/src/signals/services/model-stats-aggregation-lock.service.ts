import { sql } from "drizzle-orm";

import type { Db } from "../external/db";

type ModelStatsAggregationLockDb = Pick<Db, "execute">;

export async function lockModelStatsAggregation(
  db: ModelStatsAggregationLockDb,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(
      hashtext('vm0'),
      hashtext('model_stats_aggregation')
    )`,
  );
}
