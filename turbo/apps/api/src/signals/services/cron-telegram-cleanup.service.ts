import { command } from "ccstate";
import { sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const TELEGRAM_MESSAGE_RETENTION_DAYS = 30;
const TELEGRAM_MESSAGE_DELETE_BATCH_SIZE = 10_000;

export const cleanupTelegramMessages$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const cutoffDate = nowDate();
    cutoffDate.setDate(cutoffDate.getDate() - TELEGRAM_MESSAGE_RETENTION_DAYS);

    let totalDeleted = 0;
    let batchDeleted: number;

    do {
      const result = await db.execute(sql`
        DELETE FROM telegram_messages
        WHERE ctid IN (
          SELECT ctid FROM telegram_messages
          WHERE created_at < ${cutoffDate}
          LIMIT ${TELEGRAM_MESSAGE_DELETE_BATCH_SIZE}
        )
      `);
      signal.throwIfAborted();

      batchDeleted = Number(result.rowCount ?? 0);
      totalDeleted += batchDeleted;
    } while (batchDeleted === TELEGRAM_MESSAGE_DELETE_BATCH_SIZE);

    return totalDeleted;
  },
);
