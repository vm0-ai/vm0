import { command } from "ccstate";
import { telegramMessages } from "@okouai/db/schema/telegram-message";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { type Db, writeDb$ } from "../external/db";

const TELEGRAM_MESSAGE_RETENTION_DAYS = 30;
const TELEGRAM_MESSAGE_DELETE_BATCH_SIZE = 10_000;
const TEST_TELEGRAM_MESSAGE_DELETE_BATCH_SIZE = 2;
const telegramMessageCtid = sql`ctid`.mapWith(pgTextDecoder);

function retentionCutoff(): Date {
  const cutoffDate = nowDate();
  cutoffDate.setUTCDate(
    cutoffDate.getUTCDate() - TELEGRAM_MESSAGE_RETENTION_DAYS,
  );
  return cutoffDate;
}

async function cleanupTelegramMessages(
  db: Db,
  cutoff: Date,
  officialOrgId: string | undefined,
  batchSize: number,
  signal: AbortSignal,
): Promise<number> {
  const expiredWhere =
    officialOrgId === undefined
      ? lt(telegramMessages.createdAt, cutoff)
      : and(
          lt(telegramMessages.createdAt, cutoff),
          eq(telegramMessages.officialOrgId, officialOrgId),
        );

  let totalDeleted = 0;
  let batchDeleted: number;

  do {
    const expiredMessages = db
      .select({ ctid: telegramMessageCtid })
      .from(telegramMessages)
      .where(expiredWhere)
      .limit(batchSize);
    const { rowCount } = await db
      .delete(telegramMessages)
      .where(inArray(telegramMessageCtid, expiredMessages));
    signal.throwIfAborted();

    batchDeleted = rowCount ?? 0;
    totalDeleted += batchDeleted;
  } while (batchDeleted === batchSize);

  return totalDeleted;
}

export const cleanupTelegramMessages$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    return await cleanupTelegramMessages(
      set(writeDb$),
      retentionCutoff(),
      undefined,
      TELEGRAM_MESSAGE_DELETE_BATCH_SIZE,
      signal,
    );
  },
);

export const cleanupTelegramMessagesForTest$ = command(
  async ({ set }, marker: string, signal: AbortSignal): Promise<number> => {
    return await cleanupTelegramMessages(
      set(writeDb$),
      retentionCutoff(),
      marker,
      TEST_TELEGRAM_MESSAGE_DELETE_BATCH_SIZE,
      signal,
    );
  },
);
