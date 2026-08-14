import { z } from "zod";
import { sql } from "drizzle-orm";

import { executeRawRows } from "../../lib/db-raw-rows";
import type { Db } from "../external/db";

type ChatEventRetentionLockDb = Pick<Db, "execute">;

const lockRowSchema = z.object({ acquired: z.boolean() });

export async function tryLockChatEventRetention(
  db: ChatEventRetentionLockDb,
): Promise<boolean> {
  const rows = await executeRawRows(
    db,
    sql`
      SELECT pg_try_advisory_xact_lock(
        hashtext('vm0'),
        hashtext('chat_event_retention')
      ) AS acquired
    `,
    lockRowSchema,
  );
  const acquired = rows[0]?.acquired;
  if (acquired === undefined) {
    throw new Error("Chat event retention lock query returned no row");
  }
  return acquired;
}

export async function lockChatEventRetention(
  db: ChatEventRetentionLockDb,
): Promise<void> {
  await db.execute(
    sql`
      SELECT pg_advisory_xact_lock(
        hashtext('vm0'),
        hashtext('chat_event_retention')
      )
    `,
  );
}
