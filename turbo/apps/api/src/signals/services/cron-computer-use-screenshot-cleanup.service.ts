import { command } from "ccstate";
import { and, inArray, lt, sql } from "drizzle-orm";

import { isStoredScreenshotPointer } from "@vm0/api-contracts/contracts/zero-computer-use";
import { computerUseCommands } from "@vm0/db/schema/computer-use-host";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { deleteS3Objects } from "../external/s3";

const SCREENSHOT_RETENTION_DAYS = 30;
const SCREENSHOT_CLEANUP_BATCH_SIZE = 500;

/**
 * Delete computer-use screenshots older than the retention window from object
 * storage and rewrite the result pointer to `{ type: "expired" }`. Also sheds
 * the bytes of legacy inline `data:` screenshots that predate object storage by
 * tombstoning them, removing existing JSONB bloat. Batched to avoid long locks.
 */
export const cleanupComputerUseScreenshots$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const cutoff = nowDate();
    cutoff.setDate(cutoff.getDate() - SCREENSHOT_RETENTION_DAYS);

    let totalCleaned = 0;
    let batchCount: number;
    do {
      const rows = await db
        .select({
          id: computerUseCommands.id,
          result: computerUseCommands.result,
        })
        .from(computerUseCommands)
        .where(
          and(
            lt(computerUseCommands.createdAt, cutoff),
            sql`jsonb_exists(${computerUseCommands.result}, 'screenshot')`,
            sql`(${computerUseCommands.result}->'screenshot'->>'type' = 's3' OR jsonb_typeof(${computerUseCommands.result}->'screenshot') = 'string')`,
          ),
        )
        .limit(SCREENSHOT_CLEANUP_BATCH_SIZE);
      signal.throwIfAborted();

      batchCount = rows.length;
      if (batchCount === 0) {
        break;
      }

      const keysByBucket = new Map<string, string[]>();
      const ids: string[] = [];
      for (const row of rows) {
        ids.push(row.id);
        const screenshot = row.result?.screenshot;
        if (isStoredScreenshotPointer(screenshot)) {
          const keys = keysByBucket.get(screenshot.bucket) ?? [];
          keys.push(screenshot.key);
          keysByBucket.set(screenshot.bucket, keys);
        }
      }

      for (const [bucket, keys] of keysByBucket) {
        await get(deleteS3Objects(bucket, keys));
        signal.throwIfAborted();
      }

      await db
        .update(computerUseCommands)
        .set({
          result: sql`jsonb_set(${computerUseCommands.result}, '{screenshot}', '{"type":"expired"}'::jsonb)`,
          updatedAt: nowDate(),
        })
        .where(inArray(computerUseCommands.id, ids));
      signal.throwIfAborted();

      totalCleaned += batchCount;
    } while (batchCount === SCREENSHOT_CLEANUP_BATCH_SIZE);

    return totalCleaned;
  },
);
