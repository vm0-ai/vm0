import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { sql } from "drizzle-orm";
import { logger } from "../../../../src/lib/logger";
import { env } from "../../../../src/env";

const log = logger("cron:telegram-cleanup");

// Retention period: 30 days
const RETENTION_DAYS = 30;
// Batch size for deletion to avoid long-running transactions
const BATCH_SIZE = 10000;

export async function GET(request: Request): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization");
  const cronSecret = env().CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

  log.debug(
    `Deleting telegram messages older than ${cutoffDate.toISOString()}...`,
  );

  let totalDeleted = 0;

  // Batch delete to avoid long-running transactions
  // Uses ctid-based subquery to limit rows per batch
  let batchDeleted: number;
  do {
    const result = await globalThis.services.db.execute(sql`
      DELETE FROM telegram_messages
      WHERE ctid IN (
        SELECT ctid FROM telegram_messages
        WHERE created_at < ${cutoffDate}
        LIMIT ${BATCH_SIZE}
      )
    `);
    batchDeleted = Number(result.rowCount ?? 0);
    totalDeleted += batchDeleted;

    if (batchDeleted > 0) {
      log.debug(`Deleted batch of ${batchDeleted} messages`);
    }
  } while (batchDeleted === BATCH_SIZE);

  log.debug(`Telegram cleanup complete: ${totalDeleted} messages deleted`);

  return NextResponse.json({ deleted: totalDeleted });
}
