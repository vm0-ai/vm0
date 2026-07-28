import { sql } from "drizzle-orm";

import type { Db } from "../external/db";

type UsageEventCompactionLockDb = Pick<Db, "execute">;

export async function lockUsageEventCompaction(
  db: UsageEventCompactionLockDb,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(
      hashtext('vm0'),
      hashtext('usage_event_compaction')
    )`,
  );
}
