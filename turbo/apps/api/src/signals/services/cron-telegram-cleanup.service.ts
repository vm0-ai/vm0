import { command } from "ccstate";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { inArray, lt, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const TELEGRAM_MESSAGE_RETENTION_DAYS = 30;
const TELEGRAM_MESSAGE_DELETE_BATCH_SIZE = 10_000;
const telegramMessageCtid = sql`ctid`.mapWith(pgTextDecoder);

export const cleanupTelegramMessages$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const cutoffDate = nowDate();
    cutoffDate.setUTCDate(
      cutoffDate.getUTCDate() - TELEGRAM_MESSAGE_RETENTION_DAYS,
    );

    let totalDeleted = 0;
    let batchDeleted: number;

    do {
      const expiredMessages = db
        .select({ ctid: telegramMessageCtid })
        .from(telegramMessages)
        .where(lt(telegramMessages.createdAt, cutoffDate))
        .limit(TELEGRAM_MESSAGE_DELETE_BATCH_SIZE);
      const { rowCount } = await db
        .delete(telegramMessages)
        .where(inArray(telegramMessageCtid, expiredMessages));
      signal.throwIfAborted();

      batchDeleted = rowCount ?? 0;
      totalDeleted += batchDeleted;
    } while (batchDeleted === TELEGRAM_MESSAGE_DELETE_BATCH_SIZE);

    return totalDeleted;
  },
);
