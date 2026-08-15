import { sql } from "drizzle-orm";

import type { Db } from "../external/db";

/** Serialize goal lifecycle changes before taking the chat queue row lock. */
export async function lockGoalThread(
  tx: Pick<Db, "execute">,
  threadId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('goal:' || ${threadId}))`,
  );
}
